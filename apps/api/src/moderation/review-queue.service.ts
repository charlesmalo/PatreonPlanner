import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FlagStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeTitle } from '../recommendations/normalize-title';
import { ModerationService } from './moderation.service';

const MAX_PAGE = 50;

@Injectable()
export class ReviewQueueService {
  private readonly logger = new Logger(ReviewQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  /**
   * Design §7's review queue: flagged entries first, then the rest oldest-first, including
   * REJECTED and DELETED so the bin is reachable.
   *
   * A read model of its own rather than a flag on the board query — the board hides statuses
   * this shows and hides the submitter this exposes, and one query serving two visibility rules
   * is how a leak gets written.
   */
  async list(creatorId: string, offset = 0, limit = 20) {
    const take = Math.min(Math.max(limit, 1), MAX_PAGE);

    // Ordered in SQL over a count of *open* flags only. Prisma's `orderBy: { flags: { _count } }`
    // has no `where`, so it counts resolved and dismissed reports too — which left an entry whose
    // reports had all been handled pinned to the top of the queue showing "Reports (0)", while a
    // live report sat below it. Paging in memory would only sort the page, putting the wrong
    // entries on it, so the ordering has to happen before the limit.
    const ordered = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT r."id"
      FROM "Recommendation" r
      LEFT JOIN "Flag" f ON f."recommendationId" = r."id" AND f."status" = 'OPEN'
      WHERE r."creatorId" = ${creatorId}::uuid
      GROUP BY r."id", r."createdAt"
      ORDER BY COUNT(f."id") DESC, r."createdAt" ASC
      LIMIT ${take + 1} OFFSET ${offset}
    `;
    const orderedIds = ordered.map((row) => row.id);
    if (orderedIds.length === 0) return { items: [], nextOffset: null };

    const rows = await this.prisma.recommendation.findMany({
      // Still scoped by creatorId as well as the id list: a defence-in-depth pairing, so a future
      // change to the raw query above cannot alone leak another tenant's entries.
      where: { id: { in: orderedIds }, creatorId },
      select: {
        id: true,
        customTitle: true,
        description: true,
        status: true,
        upvoteCount: true,
        createdAt: true,
        submittedBy: { select: { id: true, fullName: true, avatarUrl: true } },
        flags: {
          where: { status: 'OPEN' },
          select: {
            id: true,
            reason: true,
            note: true,
            createdAt: true,
            flaggedBy: { select: { id: true, fullName: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        _count: { select: { flags: { where: { status: 'OPEN' } } } },
      },
    });

    // `IN` returns rows in whatever order Postgres likes, so the priority order from the query
    // above has to be reapplied here.
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items = orderedIds.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });

    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return {
      items: page.map(({ _count, ...item }) => ({ ...item, openFlagCount: _count.flags })),
      nextOffset: hasMore ? offset + take : null,
    };
  }

  /**
   * Design §6.6's edit/redact. The previous text survives only in the audit row: keeping it on
   * the recommendation for display would defeat the point of redacting it.
   */
  async redact(
    creatorId: string,
    recommendationId: string,
    actorUserId: string,
    changes: { customTitle?: string; description?: string },
    note?: string,
  ) {
    const fields = Object.entries(changes).filter(([, value]) => value !== undefined);
    if (fields.length === 0) {
      // Otherwise every empty PATCH writes an audit row claiming an edit that did not happen.
      throw new BadRequestException('No fields to change');
    }

    const current = await this.prisma.recommendation.findFirst({
      where: { id: recommendationId, creatorId },
      select: { id: true, customTitle: true, description: true },
    });
    if (!current) throw new NotFoundException();

    // A moderator's replacement text is still text on a public board. Design §6.5 runs it
    // through the same pipeline as a patron's.
    const verdict = await this.moderation.review(fields.map(([, value]) => value as string));
    if (verdict.verdict === 'BLOCK') {
      this.logger.warn(`Blocked redaction by ${actorUserId} on recommendation ${recommendationId}`);
      throw new BadRequestException('Rejected');
    }

    const before = Object.fromEntries(
      fields.map(([key]) => [key, current[key as keyof typeof changes] ?? null]),
    );
    const after = Object.fromEntries(fields);

    return this.prisma.$transaction(async (tx) => {
      // Conditional on the text the snapshot was taken from. Without it a second redaction of the
      // same entry records the first moderator's replacement as the "original", and the true
      // original is gone from the log for good.
      const { count } = await tx.recommendation.updateMany({
        where: {
          id: recommendationId,
          creatorId,
          ...Object.fromEntries(fields.map(([key]) => [key, current[key as keyof typeof changes]])),
        },
        data: {
          ...after,
          // Recomputed with the title, or the pre-redaction text lives on in the de-duplication
          // key: a resubmission of the original abusive title would resolve to this entry as a
          // duplicate, while the redacted title would not de-duplicate at all.
          ...(after.customTitle ? { normalizedTitle: normalizeTitle(after.customTitle) } : {}),
        },
      });
      if (count === 0) {
        throw new ConflictException('That entry changed while you were editing it');
      }
      const updated = await tx.recommendation.findUniqueOrThrow({
        where: { id: recommendationId },
        select: { id: true, customTitle: true, description: true, status: true },
      });
      await tx.moderationAction.create({
        data: {
          recommendationId,
          actorUserId,
          action: 'EDIT',
          note: note ?? null,
          before,
          after,
        },
      });
      return updated;
    });
  }

  /** Design §6.6: resolve or dismiss, audited like every other moderator action. */
  async resolveFlag(
    creatorId: string,
    flagId: string,
    actorUserId: string,
    status: FlagStatus,
    note?: string,
  ) {
    if (status === 'OPEN') {
      // Reopening is not a moderator action the design defines, and allowing it would let the
      // priority signal be inflated by staff rather than by reporters.
      throw new BadRequestException('A flag cannot be reopened');
    }

    // A flag id alone says nothing about which board it belongs to; the join is what scopes it.
    const flag = await this.prisma.flag.findFirst({
      where: { id: flagId, recommendation: { creatorId } },
      select: { id: true, status: true, recommendationId: true },
    });
    if (!flag) throw new NotFoundException();
    if (flag.status !== 'OPEN') {
      // Re-resolving overwrites who handled it and when, and appends an audit row whose `before`
      // is a state the design defines no transition out of.
      throw new ConflictException('That report has already been handled');
    }

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.flag.updateMany({
        where: { id: flagId, status: 'OPEN' },
        data: { status, resolvedByUserId: actorUserId, resolvedAt: new Date() },
      });
      // Conditional for the same reason the status transition is: the check above ran before the
      // transaction, so two moderators clicking at once would otherwise both write.
      if (count === 0) throw new ConflictException('That report has already been handled');
      const updated = { id: flagId, status };
      await tx.moderationAction.create({
        data: {
          recommendationId: flag.recommendationId,
          actorUserId,
          action: status === 'RESOLVED' ? 'FLAG_RESOLVED' : 'FLAG_DISMISSED',
          note: note ?? null,
          before: { flagId, status: flag.status },
          after: { flagId, status },
        } satisfies Prisma.ModerationActionUncheckedCreateInput,
      });
      return updated;
    });
  }
}
