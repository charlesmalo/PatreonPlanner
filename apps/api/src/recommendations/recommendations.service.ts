import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  MediaType,
  Prisma,
  RecommendationStatus,
  RelationKind,
  StrikeReason,
} from '@prisma/client';
import type { StaffRoleValue } from '../access/capability';
import { AbuseService } from '../abuse/abuse.service';
import { NOTE_FIELDS } from '../notes/notes.service';
import { AvailabilityService, StoredAvailability } from '../availability/availability.service';
import { CatalogService } from '../catalog/catalog.service';
import { ConfigService } from '../config/config.module';
import { RateLimitService } from '../limits/rate-limit.service';
import { ModerationService } from '../moderation/moderation.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubmitRecommendationDto } from './dto/submit-recommendation.dto';
import { PATRON_VISIBLE_STATUSES } from '../moderation/transitions';
import { normalizeTitle } from './normalize-title';

const MAX_PAGE = 50;

/**
 * How many de-duplicated resubmissions in an hour earn a strike. A refunded duplicate is free to
 * the limiter but not to us: it already spent a moderation pass and a catalogue call before the
 * de-dupe check saw it, so replaying one was unlimited and free.
 */
export const DUPLICATE_STRIKE_THRESHOLD = 5;

/**
 * How many 429s in an hour earn a strike. Design §6.4 says strikes come from *repeated*
 * rate-limit hits, and the submission cap is one an hour: a patron with a second idea ten
 * minutes later is not an abuser, and striking their first 429 timed them out of every board
 * they pay for after three impatient clicks.
 */
export const RATE_LIMIT_STRIKE_THRESHOLD = 5;

/**
 * What the board projection adds and a single-entry response cannot compute: a parent depends on
 * what else is on the board, and themes arrive with enrichment. Both resolve on the next read;
 * what matters here is that the shape matches, so a prepended card is not a different kind of
 * object from the ones beside it.
 */
export const BOARD_ONLY_DEFAULTS = {
  availability: null,
  parentId: null,
  themes: [] as Array<{ id: string; name: string }>,
};

/**
 * Renames the `creatorNotes` relation to the `notes` the contract uses, so a single-entry
 * response is the same shape as a board entry. The relation had to dodge Recommendation's own
 * `notes` scalar; the API does not have to inherit that.
 */
export function present<T extends { creatorNotes?: unknown[] }>(row: T) {
  const { creatorNotes, ...rest } = row;
  return { ...rest, notes: creatorNotes ?? [] };
}

// Containment only. RELATED means "similar", and nesting on it would bury unrelated entries.
const NESTING_KINDS: RelationKind[] = ['SEASON_OF', 'SAME_FRANCHISE'];

/** Which canonical media type each binding content class resolves against. */
const MEDIA_TYPES: Record<'MOVIE' | 'SHOW' | 'FRANCHISE', MediaType> = {
  MOVIE: 'MOVIE',
  SHOW: 'TV',
  FRANCHISE: 'COLLECTION',
};
// Not writable. DELETED is a soft delete and REJECTED a moderation outcome; neither may be
// upvoted, whatever the read model shows a moderator.
const HIDDEN_STATUSES: RecommendationStatus[] = ['DELETED', 'REJECTED'];

/**
 * How a column is ordered, and the keyset that pages it.
 *
 * Both are derived from one place on purpose: an ordering and a cursor comparison that disagree
 * page the wrong way silently — rows repeat or vanish, and nothing errors.
 */
function boardOrdering(sort: BoardSort): Prisma.RecommendationOrderByWithRelationInput[] {
  // The creator's picks lead every sort. Below them the chosen order applies as usual.
  const pick = { isCreatorPick: 'desc' } as const;
  if (sort === 'newest') return [pick, { createdAt: 'desc' }, { id: 'desc' }];
  if (sort === 'oldest') return [pick, { createdAt: 'asc' }, { id: 'asc' }];
  return [pick, { upvoteCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];
}

function afterCursor(sort: BoardSort, cursor: BoardCursor): Prisma.RecommendationWhereInput {
  const ascending = sort === 'oldest';
  const beyond = ascending ? { gt: cursor.createdAt } : { lt: cursor.createdAt };
  const tie = ascending ? { gt: cursor.id } : { lt: cursor.id };

  const withinPickGroup: Prisma.RecommendationWhereInput[] =
    sort === 'upvotes'
      ? [
          { upvoteCount: { lt: cursor.upvoteCount } },
          { upvoteCount: cursor.upvoteCount, createdAt: { lt: cursor.createdAt } },
          { upvoteCount: cursor.upvoteCount, createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ]
      : [{ createdAt: beyond }, { createdAt: cursor.createdAt, id: tie }];

  return {
    OR: [
      // Picks sort first, so once past them everything unpicked follows.
      ...(cursor.isCreatorPick ? [{ isCreatorPick: false }] : []),
      { isCreatorPick: cursor.isCreatorPick, OR: withinPickGroup },
    ],
  };
}

/**
 * Design §7: staff read the whole board including the bin, patrons read only the visible
 * statuses — minus pending entries when the creator hides them, except their own.
 */
export function visibilityWhere(
  creator: { hidePendingFromPublic: boolean },
  viewer: { userId: string | null; staffRole: StaffRoleValue | null },
): Prisma.RecommendationWhereInput {
  if (viewer.staffRole !== null) return {};
  if (!creator.hidePendingFromPublic) return { status: { in: PATRON_VISIBLE_STATUSES } };
  return {
    OR: [
      { status: { in: PATRON_VISIBLE_STATUSES.filter((s) => s !== 'PENDING') } },
      // Hiding a patron's own submission from them makes the submit form look broken: success,
      // then an empty board. Anonymous has no id and so matches nothing here, which is right.
      ...(viewer.userId ? [{ status: 'PENDING' as const, submittedByUserId: viewer.userId }] : []),
    ],
  };
}

export type BoardSort = 'upvotes' | 'newest' | 'oldest';

interface BoardCursor {
  upvoteCount: number;
  createdAt: Date;
  id: string;
  /** Leads every ordering, so it has to lead the cursor comparison too. */
  isCreatorPick: boolean;
}

function encodeCursor(row: {
  upvoteCount: number;
  createdAt: Date;
  id: string;
  isCreatorPick: boolean;
}): string {
  return Buffer.from(
    JSON.stringify({
      u: row.upvoteCount,
      c: row.createdAt.toISOString(),
      i: row.id,
      p: row.isCreatorPick,
    }),
  ).toString('base64url');
}

function decodeCursor(raw: string | undefined): BoardCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      u: number;
      c: string;
      i: string;
      p?: boolean;
    };
    const createdAt = new Date(parsed.c);
    if (typeof parsed.u !== 'number' || Number.isNaN(createdAt.getTime()) || !parsed.i) {
      throw new Error('malformed');
    }
    return {
      upvoteCount: parsed.u,
      createdAt,
      id: parsed.i,
      isCreatorPick: parsed.p === true,
    };
  } catch {
    // A cursor we did not mint is a client bug, not an empty board.
    throw new BadRequestException('Invalid cursor');
  }
}

// Explicit select: the submitter is a User row carrying an email and Patreon id, neither of
// which belongs on a public board.
export const RECOMMENDATION_FIELDS = {
  id: true,
  type: true,
  customTitle: true,
  description: true,
  status: true,
  upvoteCount: true,
  isCreatorPick: true,
  createdAt: true,
  title: {
    // `id` is what GET /catalog/titles/:id/availability keys on. Without it the endpoint is
    // unreachable: no response anywhere exposed the catalogue row's id.
    select: { id: true, tmdbId: true, mediaType: true, name: true, year: true, posterPath: true },
  },
  links: { select: { url: true, label: true } },
  // TIMELINE only. A NOTE is editor commentary and must never reach the patron board — the kind
  // is the whole point of the model, so the filter lives in the projection rather than in a
  // caller who might forget it.
  creatorNotes: {
    where: { kind: 'TIMELINE' },
    select: NOTE_FIELDS,
    orderBy: { createdAt: 'asc' },
  },
  watchOrderItems: {
    select: {
      position: true,
      customTitle: true,
      note: true,
      title: {
        select: {
          id: true,
          tmdbId: true,
          mediaType: true,
          name: true,
          year: true,
          posterPath: true,
        },
      },
    },
    orderBy: { position: 'asc' },
  },
  submittedBy: { select: { id: true, fullName: true, avatarUrl: true } },
} satisfies Prisma.RecommendationSelect;

@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: RateLimitService,
    private readonly moderation: ModerationService,
    private readonly config: ConfigService,
    private readonly catalog: CatalogService,
    private readonly availability: AvailabilityService,
    private readonly abuse: AbuseService,
  ) {}

  /**
   * The returned recommendation carries hasUpvoted like the board's does. Without it a client
   * prepending the result renders a card in a different shape from every other card — which is
   * precisely what the end-to-end suite caught.
   */
  async submit(creatorId: string, userId: string, dto: SubmitRecommendationDto) {
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
      await this.countTowardStrike(
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
      await this.recordStrike(userId, 'MODERATION_BLOCK');
      throw new BadRequestException('Submission rejected');
    }

    // Resolved after moderation, for the same reason de-dupe is: a blocked submission must not
    // be able to probe the catalogue or spend its quota.
    const title = await this.resolveTitle(dto);
    // Resolved here rather than inside create(), for two reasons. A duplicate must not skip item
    // validation — the same body was a 400 with a fresh name and a 200 with a taken one. And the
    // Title upserts these do must sit outside the P2002 catch below, which reads any unique
    // violation as "someone won the de-dupe race".
    const items = await this.resolveItems(dto);

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
      select: RECOMMENDATION_FIELDS,
    });
    // Design §5: a resubmit returns the existing entry and invites an upvote rather than
    // erroring — a creator's board is a demand signal, and a 409 would lose it.
    if (existing) {
      // Refund: nothing was created, and at 1/hour charging for it would lock a patron out for
      // an hour for doing exactly what design §5 wants them to do.
      await this.refund(perCreatorKey, globalKey);
      await this.countDuplicate(userId, creatorId);
      return { duplicate: true as const, recommendation: await this.withUpvoted(existing, userId) };
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
          select: RECOMMENDATION_FIELDS,
        });
        // No winner means the violation came from somewhere else — a Title upsert, say — and
        // reporting it as a duplicate would refund the limit and lose the submission.
        if (!winner) throw error;
        await this.refund(perCreatorKey, globalKey);
        await this.countDuplicate(userId, creatorId);
        return { duplicate: true as const, recommendation: await this.withUpvoted(winner, userId) };
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
  async findOne(
    creator: { id: string; hidePendingFromPublic: boolean },
    id: string,
    viewer: { userId: string | null; staffRole: StaffRoleValue | null },
  ) {
    const entry = await this.prisma.recommendation.findFirst({
      where: {
        AND: [{ id, creatorId: creator.id }, visibilityWhere(creator, viewer)],
      },
      select: RECOMMENDATION_FIELDS,
    });
    if (!entry) throw new NotFoundException();

    return viewer.userId
      ? this.withUpvoted(entry, viewer.userId)
      : { ...present(entry), hasUpvoted: false, ...BOARD_ONLY_DEFAULTS };
  }

  /**
   * The creator's own shortlist. Scoped by creator as well as id — an id alone says nothing about
   * which board an entry is on.
   */
  async setCreatorPick(creatorId: string, id: string, isCreatorPick: boolean): Promise<void> {
    const { count } = await this.prisma.recommendation.updateMany({
      where: { id, creatorId },
      data: { isCreatorPick },
    });
    if (count === 0) throw new NotFoundException();
  }

  private async withUpvoted<T extends { id: string; creatorNotes?: unknown[] }>(
    recommendation: T,
    userId: string,
  ) {
    const upvote = await this.prisma.upvote.findUnique({
      where: { recommendationId_userId: { recommendationId: recommendation.id, userId } },
      select: { id: true },
    });
    return { ...present(recommendation), hasUpvoted: upvote !== null, ...BOARD_ONLY_DEFAULTS };
  }

  /**
   * A strike is a side effect of a decision already made. It must never turn a 400 into a 500 —
   * the caller's answer does not depend on whether we managed to write it down.
   */
  private async recordStrike(userId: string, reason: StrikeReason): Promise<void> {
    try {
      await this.abuse.strike(userId, reason);
    } catch (error) {
      this.logger.warn(`Could not record a strike for user ${userId}: ${String(error)}`);
    }
  }

  /**
   * Counted rather than limited: the first few duplicates are exactly what design §5 wants.
   *
   * Keyed per creator, because a patron suggesting one popular title to each of six boards they
   * follow produces six duplicates in a session — every one of them a 200 and the behaviour §5
   * asks for. Only replaying at *one* board is the flood this guards against.
   */
  private countDuplicate(userId: string, creatorId: string): Promise<void> {
    return this.countTowardStrike(
      `duplicate:${userId}:${creatorId}`,
      DUPLICATE_STRIKE_THRESHOLD,
      'DUPLICATE_FLOOD',
      userId,
    );
  }

  /**
   * Strikes exactly once, on the request that crosses the threshold. `>=` struck on every
   * request past it, so six duplicates — a cheap, sanctioned path — earned two strikes and an
   * hour's lockout.
   */
  private async countTowardStrike(
    key: string,
    threshold: number,
    reason: StrikeReason,
    userId: string,
  ): Promise<void> {
    try {
      const seen = await this.limits.count(key, 3600);
      if (seen === threshold) await this.abuse.strike(userId, reason);
    } catch (error) {
      this.logger.warn(`Could not count ${reason} for user ${userId}: ${String(error)}`);
    }
  }

  private async refund(...keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => this.limits.refund(key)));
  }

  /**
   * Confirms a mainstream submission against the catalogue and persists the canonical title, so
   * the stored name is TMDB's rather than whatever the client typed. Returns null for external
   * links, which have no canonical identity.
   */
  private async resolveTitle(dto: SubmitRecommendationDto) {
    // Items belong to a watch order and nothing else; accepting them elsewhere would store rows
    // no read model ever surfaces.
    if (dto.type !== 'WATCH_ORDER' && dto.items !== undefined) {
      throw new BadRequestException('Only a watch order can carry items');
    }
    if (dto.type === 'EXTERNAL_LINK' || dto.type === 'WATCH_ORDER') {
      // Whitelisting keeps declared properties, so without this a client could attach a binding
      // that never passed the catalogue check.
      if (dto.tmdbId !== undefined) {
        throw new BadRequestException('This type cannot carry a catalogue id');
      }
      return null;
    }
    // The canonical name wins, so a supplied one is never used — and silently ignoring it lets a
    // submitter believe they named the entry. Symmetrical with the id check above.
    if (dto.customTitle !== undefined) {
      throw new BadRequestException('A catalogue-bound entry takes its title from the catalogue');
    }
    // A franchise is a TMDB collection: another canonical identity, so it reuses Title wholesale.
    const mediaType = MEDIA_TYPES[dto.type];
    const result = await this.catalog.fetchTitle(dto.tmdbId as number, mediaType);
    // An id the catalogue does not know is a client mistake; writing it would create an entry
    // nothing can ever resolve.
    if (!result) throw new BadRequestException('Unknown title');

    return this.prisma.title.upsert({
      where: { tmdbId_mediaType: { tmdbId: result.tmdbId, mediaType } },
      create: {
        tmdbId: result.tmdbId,
        mediaType,
        name: result.name,
        year: result.year,
        posterPath: result.posterPath,
        overview: result.overview,
      },
      update: {
        // Refreshed on each binding: posters and overviews change upstream.
        name: result.name,
        year: result.year,
        posterPath: result.posterPath,
        // Back into the enrichment queue. Themes are per creator and seeded from whoever holds
        // the title *at enrichment time*, so a title enriched for creator A and later suggested
        // on creator B's board would otherwise leave B without theme chips forever.
        enrichedAt: null,
      },
      select: { id: true, name: true },
    });
  }

  private async create(
    creatorId: string,
    userId: string,
    dto: SubmitRecommendationDto,
    displayTitle: string,
    normalizedTitle: string,
    titleId: string | null,
    items: Awaited<ReturnType<RecommendationsService['resolveItems']>>,
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
        links: dto.links
          ? { create: dto.links.map((l) => ({ url: l.url, label: l.label })) }
          : undefined,
        // Nested create, so the entry and its steps land in one statement — a watch order with
        // no steps is not a thing that should ever be readable.
        watchOrderItems: items.length > 0 ? { create: items } : undefined,
      },
      select: RECOMMENDATION_FIELDS,
    });
    // Nothing can have upvoted a recommendation that did not exist a moment ago.
    return {
      duplicate: false as const,
      recommendation: { ...present(recommendation), hasUpvoted: false, ...BOARD_ONLY_DEFAULTS },
    };
  }

  /**
   * Numbers the steps 0..n-1 from the order they arrived in. A client-supplied position is not
   * trusted: a duplicated or sparse one renders an order nobody can read, and the unique index
   * would reject it anyway.
   */
  private async resolveItems(dto: SubmitRecommendationDto) {
    if (dto.type !== 'WATCH_ORDER' || !dto.items) return [];

    const resolved: Array<{
      position: number;
      titleId?: string;
      customTitle?: string;
      note: string | null;
    }> = [];

    // Sequential, not Promise.all: fifty steps meant fifty simultaneous TMDB requests and fifty
    // concurrent upserts, which trips the upstream rate limit and exhausts the connection pool —
    // and a 429 surfaced to the patron as "Unknown title", blaming them for our fan-out.
    for (const [position, item] of dto.items.entries()) {
      const bound = item.tmdbId !== undefined;
      const titled = (item.customTitle ?? '').trim().length > 0;
      // Exactly one identity: neither leaves nothing to render, both is ambiguous about which
      // name is authoritative. The database check constraint enforces the same rule.
      if (bound === titled) {
        throw new BadRequestException('Each step needs either a catalogue id or a title');
      }
      if (!bound) {
        resolved.push({
          position,
          customTitle: (item.customTitle as string).trim(),
          note: item.note?.trim() || null,
        });
        continue;
      }
      // Required alongside tmdbId: TMDB ids are unique only within a media type, so defaulting
      // it silently bound film 1399 for a caller who meant series 1399.
      if (!item.mediaType) {
        throw new BadRequestException('A catalogue step must say whether it is a film or a show');
      }

      const mediaType: MediaType = item.mediaType === 'SHOW' ? 'TV' : 'MOVIE';
      const result = await this.catalog.fetchTitle(item.tmdbId as number, mediaType);
      if (!result) throw new BadRequestException('Unknown title in the watch order');
      const title = await this.prisma.title.upsert({
        where: { tmdbId_mediaType: { tmdbId: result.tmdbId, mediaType } },
        create: {
          tmdbId: result.tmdbId,
          mediaType,
          name: result.name,
          year: result.year,
          posterPath: result.posterPath,
          overview: result.overview,
        },
        update: {
          name: result.name,
          year: result.year,
          posterPath: result.posterPath,
          // Same reason as above: a step's title may be new to this creator's board.
          enrichedAt: null,
        },
        select: { id: true },
      });
      resolved.push({ position, titleId: title.id, note: item.note?.trim() || null });
    }
    return resolved;
  }

  /**
   * Maps each page title to the recommendation on this page that contains it.
   *
   * Only containment kinds nest — RELATED means "similar", and nesting on it would bury
   * unrelated entries under each other. Resolved within the page, so a child never nests under
   * something the viewer cannot see: the page has already been filtered by visibility.
   */
  private async parentsFor(
    page: Array<{ id: string; titleId: string | null }>,
    titleIds: string[],
    creatorId: string,
  ): Promise<Map<string, string>> {
    const parents = new Map<string, string>();
    if (titleIds.length === 0) return parents;

    const relations = await this.prisma.titleRelation.findMany({
      where: {
        kind: { in: NESTING_KINDS },
        fromId: { in: titleIds },
        toId: { in: titleIds },
      },
      select: { fromId: true, toId: true },
    });
    if (relations.length === 0) return parents;

    const entryByTitle = new Map<string, string>();
    for (const item of page) {
      // First wins: two entries for one title cannot both be the parent, and the board's own
      // de-duplication makes that pair impossible anyway.
      if (item.titleId && !entryByTitle.has(item.titleId)) entryByTitle.set(item.titleId, item.id);
    }

    for (const relation of relations) {
      const parentEntry = entryByTitle.get(relation.toId);
      // Direction is member → container, so `toId` is always the parent.
      if (parentEntry && !parents.has(relation.fromId)) {
        parents.set(relation.fromId, parentEntry);
      }
    }
    return parents;
  }

  private async themesFor(
    titleIds: string[],
    creatorId: string,
  ): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const byTitle = new Map<string, Array<{ id: string; name: string }>>();
    if (titleIds.length === 0) return byTitle;

    const rows = await this.prisma.titleTheme.findMany({
      // Scoped by creator: themes are per creator, and another creator's names must not appear.
      where: { titleId: { in: titleIds }, theme: { creatorId } },
      select: { titleId: true, theme: { select: { id: true, name: true } } },
      orderBy: { theme: { name: 'asc' } },
    });
    for (const row of rows) {
      const list = byTitle.get(row.titleId) ?? [];
      list.push(row.theme);
      byTitle.set(row.titleId, list);
    }
    return byTitle;
  }

  async toggleUpvote(creatorId: string, recommendationId: string, userId: string) {
    // Scoped by creatorId as well as id: the guard only proved access to *this* creator, so
    // without it a patron of A could upvote an entry on B's board by guessing an id.
    const rec = await this.prisma.recommendation.findFirst({
      where: { id: recommendationId, creatorId, status: { notIn: HIDDEN_STATUSES } },
      select: { id: true },
    });
    if (!rec) throw new NotFoundException();

    // The row and the counter move together, so the number on the board cannot drift from the
    // rows behind it.
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.upvote.findUnique({
        where: { recommendationId_userId: { recommendationId, userId } },
        select: { id: true },
      });
      if (existing) {
        await tx.upvote.delete({ where: { id: existing.id } });
        const updated = await tx.recommendation.update({
          where: { id: recommendationId },
          data: { upvoteCount: { decrement: 1 } },
          select: { upvoteCount: true },
        });
        return { upvoted: false, upvoteCount: updated.upvoteCount };
      }
      await tx.upvote.create({ data: { recommendationId, userId } });
      const updated = await tx.recommendation.update({
        where: { id: recommendationId },
        data: { upvoteCount: { increment: 1 } },
        select: { upvoteCount: true },
      });
      return { upvoted: true, upvoteCount: updated.upvoteCount };
    });
  }

  /**
   * Explicit keyset pagination on (upvoteCount, createdAt, id).
   *
   * Prisma's `cursor` + `skip: 1` was wrong twice over: the skip is an unconditional OFFSET 1,
   * so when the cursor row is excluded by the status filter it eats a real row instead — pages
   * silently lost entries. And it resolves the cursor row by global id, so another creator's id
   * positioned the page. Carrying the boundary values in the cursor removes both.
   *
   * Duplicates remain possible if an entry is upvoted between pages, because the leading sort
   * key is mutable. That is inherent to ordering by a live counter, not something keyset fixes;
   * callers should de-duplicate by id.
   */
  async list(
    creator: { id: string; hidePendingFromPublic: boolean },
    rawCursor: string | undefined,
    limit: number | undefined,
    viewer: { userId: string | null; staffRole: StaffRoleValue | null },
    themeId?: string,
    status?: RecommendationStatus,
    sort: BoardSort = 'upvotes',
  ) {
    const take = Math.min(Math.max(limit ?? 20, 1), MAX_PAGE);
    const cursor = decodeCursor(rawCursor);
    const viewerUserId = viewer.userId;

    // Scoped to this creator: a theme id from another board must not silently return an empty
    // page, which reads as "no matches here" rather than "that is not your theme".
    if (themeId) {
      const theme = await this.prisma.theme.findFirst({
        where: { id: themeId, creatorId: creator.id },
        select: { id: true },
      });
      if (!theme) throw new NotFoundException();
    }

    const items = (await this.prisma.recommendation.findMany({
      where: {
        creatorId: creator.id,
        ...(themeId ? { title: { themes: { some: { themeId } } } } : {}),
        // Composed with AND, never spread: both clauses are disjunctions and want the `OR` key,
        // so spreading let the cursor overwrite the visibility filter outright — page one was
        // correct and every page after it returned rejected, deleted and other patrons' pending
        // entries to anyone who clicked "Load more".
        AND: [
          visibilityWhere(creator, viewer),
          // Inside the AND with everything else: a status filter spread alongside the visibility
          // rule would overwrite it, and asking for REJECTED would return the column rather than
          // nothing. Narrowing only ever intersects.
          ...(status ? [{ status }] : []),
          ...(cursor ? [afterCursor(sort, cursor)] : []),
        ],
      },
      orderBy: boardOrdering(sort),
      take: take + 1,
      select: {
        ...RECOMMENDATION_FIELDS,
        upvoteCount: true,
        createdAt: true,
        // Selected for the availability and relation joins, then dropped from the response.
        titleId: true,
        // Whether *this* viewer upvoted. Without it a client cannot render the control's state
        // truthfully, and an optimistic toggle guesses the direction wrong.
        ...(viewerUserId
          ? { upvotes: { where: { userId: viewerUserId }, select: { id: true }, take: 1 } }
          : {}),
      },
    })) as Array<{
      id: string;
      upvoteCount: number;
      isCreatorPick: boolean;
      createdAt: Date;
      titleId: string | null;
      upvotes?: Array<{ id: string }>;
      creatorNotes?: unknown[];
    }>;

    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    const last = page[page.length - 1];

    // One query for the whole page, not one per card: twenty entries would otherwise mean twenty
    // round trips. Never blocks on the upstream — a cold board renders without badges and the
    // refresh it queues lands before the next read.
    const region = this.config.get('AVAILABILITY_REGION_DEFAULT');
    const titleIds = page.flatMap((item) => (item.titleId ? [item.titleId] : []));
    // Badges are garnish; the board is the product. The unconfigured path already degrades, but a
    // *runtime* failure here — a slow query, an exhausted pool — would otherwise 500 the whole
    // board rather than dropping the badges.
    let availability = new Map<string, StoredAvailability>();
    try {
      availability = await this.availability.forTitles(titleIds, region);
    } catch (error) {
      this.logger.warn(`Availability lookup failed for board ${creator.id}: ${String(error)}`);
    }

    const parents = await this.parentsFor(page, titleIds, creator.id);
    const themes = await this.themesFor(titleIds, creator.id);

    return {
      items: page.map(({ upvotes, titleId, creatorNotes, ...item }) => ({
        ...item,
        // `creatorNotes` is a schema artefact — the model had to dodge Recommendation's own
        // `notes` scalar. The contract says what design §7 says.
        notes: creatorNotes ?? [],
        hasUpvoted: (upvotes ?? []).length > 0,
        // Null for an external link, which has no canonical identity to look up.
        availability: (titleId && availability.get(titleId)) || null,
        // Nesting is a *per-board* projection, not a stored fact: whether an entry has a parent
        // depends on what else is on this board, which changes with every submission and every
        // status change.
        parentId: (titleId && parents.get(titleId)) || null,
        themes: (titleId && themes.get(titleId)) || [],
      })),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }
}
