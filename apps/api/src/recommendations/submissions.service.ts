import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { MediaType, Prisma, StrikeReason } from '@prisma/client';
import { AbuseService } from '../abuse/abuse.service';
import {
  RATE_LIMIT_STRIKE_THRESHOLD,
  SubmissionStrikesService,
} from './submission-strikes.service';
import { SubmissionResolverService } from './submission-resolver.service';
import { ConfigService } from '../config/config.module';
import { RateLimitService } from '../limits/rate-limit.service';
import { ModerationService } from '../moderation/moderation.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubmitRecommendationDto } from './dto/submit-recommendation.dto';
import { normalizeTitle } from './normalize-title';
import { LinksService } from './links.service';
import { HIDDEN_STATUSES } from './board-query';
import {
  BOARD_ONLY_DEFAULTS,
  present,
  recommendationFields,
  withUpvoted,
} from './recommendation-fields';

/**
 * Everything that happens when somebody proposes an entry: moderation, rate limiting,
 * de-duplication, catalogue resolution, and the strikes each of those can earn.
 *
 * Split from the board read because the two share almost nothing but a table. The read answers
 * "what is on this board for this viewer"; this answers "may this person add to it, and does
 * what they added already exist" — a different set of collaborators and a different set of
 * failure modes.
 */

@Injectable()
export class SubmissionsService {
  private readonly logger = new Logger(SubmissionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly abuse: AbuseService,
    private readonly strikes: SubmissionStrikesService,
    private readonly limits: RateLimitService,
    private readonly moderation: ModerationService,
    private readonly resolver: SubmissionResolverService,
    private readonly config: ConfigService,
    private readonly links: LinksService,
  ) {}

  /**
   * The returned recommendation carries hasUpvoted like the board's does. Without it a client
   * prepending the result renders a card in a different shape from every other card — which is
   * precisely what the end-to-end suite caught.
   */
  async submit(
    creatorId: string,
    userId: string,
    dto: SubmitRecommendationDto,
    isStaff = false,
    // How it arrived, for the parts of the row that are about provenance rather than content. A
    // carried-over entry is labelled so a moderator can judge a class of them at once.
    origin: { viaCarryOver?: boolean } = {},
  ) {
    // Before the limiter, so a timed-out request does the least possible work — and so a blocked
    // caller does not also burn the hourly quota they will want when the timeout lifts.
    const timeoutUntil = await this.abuse.timeoutFor(userId);
    if (timeoutUntil) {
      // Says when, never why: design §9 wants no probing of the rules, and explaining the curve
      // invites gaming it.
      throw new ForbiddenException({
        message: 'You cannot suggest anything right now',
        retryAt: timeoutUntil.toISOString(),
      });
    }

    // Rate limit next: moderation is the expensive stage, and a flood must not be able to
    // drive that cost.
    const perCreatorKey = `submit:${userId}:${creatorId}`;
    const globalKey = `submit-global:${userId}`;
    const allowed = await this.limits.consume(
      perCreatorKey,
      this.config.get('SUBMIT_LIMIT_PER_HOUR'),
      3600,
    );
    // Design §6 item 3 pairs the per-creator limit with a looser global one; without it a patron
    // of twenty creators floods at twenty an hour.
    const globallyAllowed = await this.limits.consume(
      globalKey,
      this.config.get('SUBMIT_LIMIT_PER_HOUR_GLOBAL'),
      3600,
    );
    if (!allowed || !globallyAllowed) {
      await this.strikes.countTowardStrike(
        `ratelimited:${userId}`,
        RATE_LIMIT_STRIKE_THRESHOLD,
        'RATE_LIMIT',
        userId,
      );
      throw new HttpException('Too many submissions', HttpStatus.TOO_MANY_REQUESTS);
    }

    // Link labels and URLs are user-controlled and rendered on the board, so they go through
    // the pipeline too. Reviewing only title and description left the whole content-safety
    // control bypassable by putting the text in a label.
    const moderation = await this.moderation.review(
      // No id: the entry does not exist yet, and on a BLOCK it never will — which is exactly the
      // case the record is evidence for.
      { creatorId, userId, type: 'RECOMMENDATION' },
      [
        dto.customTitle,
        dto.description,
        ...(dto.links?.flatMap((link) => [link.label, link.url]) ?? []),
        // Item text is exactly where a submitter would route around a title-only check.
        ...(dto.items?.flatMap((item) => [item.customTitle, item.note]) ?? []),
      ],
    );
    if (moderation.verdict === 'BLOCK') {
      // Generic to the caller, specific in the log: design §9 wants no probing of the rules.
      this.logger.warn(`Blocked submission from user ${userId} to creator ${creatorId}`);
      // Design §6.5: a BLOCK is a strike. This is the durable record §6.4 asks for.
      await this.strikes.recordStrike(userId, 'MODERATION_BLOCK');
      throw new BadRequestException('Submission rejected');
    }

    // Resolved after moderation, for the same reason de-dupe is: a blocked submission must not
    // be able to probe the catalogue or spend its quota.
    const title = await this.resolver.resolveTitle(dto);
    // Resolved here rather than inside create(), for two reasons. A duplicate must not skip item
    // validation — the same body was a 400 with a fresh name and a 200 with a taken one. And the
    // Title upserts these do must sit outside the P2002 catch below, which reads any unique
    // violation as "someone won the de-dupe race".
    const items = await this.resolver.resolveItems(dto);

    // De-dupe after moderation, so a blocked resubmission cannot be used to confirm what
    // already exists on a board the sender cannot read.
    const displayTitle = title?.name ?? (dto.customTitle as string);
    const normalizedTitle = normalizeTitle(displayTitle);
    // A title of pure punctuation carries no de-dupe key; storing '' would make every such
    // title collide.
    if (normalizedTitle.length === 0) throw new BadRequestException('Title must contain letters');
    // Canonical when bound, normalized-title otherwise — matching the two partial indexes that
    // actually enforce it.
    const existing = await this.prisma.recommendation.findFirst({
      where: title
        ? { creatorId, titleId: title.id, type: dto.type, status: { notIn: HIDDEN_STATUSES } }
        : {
            creatorId,
            titleId: null,
            normalizedTitle,
            // Scoped by type, matching the partial index: a watch order and an external link
            // that happen to share a name are different suggestions.
            type: dto.type,
            status: { notIn: HIDDEN_STATUSES },
          },
      select: recommendationFields({ userId, isStaff }),
    });
    // Design §5: a resubmit returns the existing entry and invites an upvote rather than
    // erroring — a creator's board is a demand signal, and a 409 would lose it.
    if (existing) {
      // Refund: nothing was created, and at 1/hour charging for it would lock a patron out for
      // an hour for doing exactly what design §5 wants them to do.
      await this.strikes.refund(perCreatorKey, globalKey);
      await this.strikes.countDuplicate(userId, creatorId);
      // The link is the new information in a repeat submission. Throwing it away is what this
      // replaces — it queues as a candidate for staff rather than publishing itself.
      if (dto.links?.length) {
        existing.links = await this.links.contribute(
          this.prisma,
          existing.id,
          userId,
          isStaff,
          dto.links,
        );
      }
      return {
        duplicate: true as const,
        recommendation: await withUpvoted(this.prisma, existing, userId),
      };
    }

    try {
      const created = await this.create(
        creatorId,
        userId,
        dto,
        displayTitle,
        normalizedTitle,
        title?.id ?? null,
        items,
        isStaff,
        origin,
      );
      // A FLAG is reviewed before the entry exists — it has to be, or a BLOCK would create one —
      // so the record was written with no subject. Linked now there is something to link to,
      // which is what lets the review queue find it.
      await this.moderation.attachSubject(moderation.recordId, created.recommendation.id);
      return created;
    } catch (error) {
      // Two patrons submitting the same title concurrently both miss the read above; the unique
      // index is what actually enforces de-duplication, and the loser resolves to the winner's
      // row rather than erroring.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.prisma.recommendation.findFirst({
          where: title
            ? { creatorId, titleId: title.id, type: dto.type }
            : { creatorId, titleId: null, normalizedTitle, type: dto.type },
          select: recommendationFields({ userId, isStaff }),
        });
        // No winner means the violation came from somewhere else — a Title upsert, say — and
        // reporting it as a duplicate would refund the limit and lose the submission.
        if (!winner) throw error;
        await this.strikes.refund(perCreatorKey, globalKey);
        await this.strikes.countDuplicate(userId, creatorId);
        if (dto.links?.length) {
          winner.links = await this.links.contribute(
            this.prisma,
            winner.id,
            userId,
            isStaff,
            dto.links,
          );
        }
        return {
          duplicate: true as const,
          recommendation: await withUpvoted(this.prisma, winner, userId),
        };
      }
      throw error;
    }
  }

  /**
   * A duplicate may already be upvoted by this viewer; a fresh one never is.
   *
   * Also fills the fields the *board* projection adds, because a client prepending this result
   * renders it as a card alongside board entries — and a card missing them crashes. That lesson
   * is already written above for `hasUpvoted`; nesting and themes joined it the same way.
   */
  /**
   * One entry, by id, under the same visibility rule the board list applies.
   *
   * Composed with AND rather than spread, for the reason the list already carries: both clauses
   * can want the `OR` key, and a spread lets the last one win — which is how page two of every
   * board once returned rejected and other patrons' pending entries.
   *
   * A hidden entry is a 404 rather than a 403: telling the reader an id exists but is not for
   * them is itself the leak, since it confirms what is on a board they cannot see.
   */

  private async create(
    creatorId: string,
    userId: string,
    dto: SubmitRecommendationDto,
    displayTitle: string,
    normalizedTitle: string,
    titleId: string | null,
    items: Awaited<ReturnType<SubmissionResolverService['resolveItems']>>,
    isStaff: boolean,
    origin: { viaCarryOver?: boolean } = {},
  ) {
    const recommendation = await this.prisma.recommendation.create({
      data: {
        creatorId,
        submittedByUserId: userId,
        type: dto.type,
        customTitle: displayTitle,
        normalizedTitle,
        titleId,
        description: dto.description ?? null,
        viaCarryOver: origin.viaCarryOver ?? false,
        // Links go in through LinksService below rather than nested here: whether one is
        // published or waits for a human depends on who submitted it, and that decision belongs
        // in one place.
        // Nested create, so the entry and its steps land in one statement — a watch order with
        // no steps is not a thing that should ever be readable.
        watchOrderItems: items.length > 0 ? { create: items } : undefined,
      },
      select: recommendationFields({ userId, isStaff }),
    });
    // Re-read rather than echoing what was sent: `contribute` de-duplicates and decides whether
    // each link is published or a candidate, so the response has to describe what was actually
    // stored. The row above was selected before any of that ran, so its links are empty.
    const links = await this.links.contribute(
      this.prisma,
      recommendation.id,
      userId,
      isStaff,
      dto.links ?? [],
    );

    // Nothing can have upvoted a recommendation that did not exist a moment ago.
    return {
      duplicate: false as const,
      recommendation: {
        ...present({ ...recommendation, links }),
        hasUpvoted: false,
        ...BOARD_ONLY_DEFAULTS,
      },
    };
  }
}
