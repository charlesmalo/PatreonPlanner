import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FlagStatus, Prisma } from '@prisma/client';
import { AbuseService } from '../abuse/abuse.service';
import { NOTE_FIELDS } from '../notes/notes.service';
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
    private readonly abuse: AbuseService,
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
        // A watch order's text is mostly *in* its steps; a queue that hid them would be
        // reviewing a title and nothing else.
        watchOrderItems: {
          select: {
            position: true,
            customTitle: true,
            note: true,
            title: { select: { name: true } },
          },
          orderBy: { position: 'asc' },
        },
        // Every kind: the queue is the surface where a moderator reads their own commentary.
        creatorNotes: { select: NOTE_FIELDS, orderBy: { createdAt: 'asc' } },
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

    // Why the *system* flagged something, which this queue recorded and never showed. The row is
    // written by ModerationService, pointed at the entry by `attachSubject` — "which is what lets
    // the review queue find it" — and indexed by `subjectId` for this exact lookup. One query for
    // the page, like the board does for availability, rather than one per row.
    //
    // Scoped by creator as well as by id: a subject id is a uuid and says nothing about which
    // board it belongs to, and every other read here is scoped the same way.
    const judged = await this.prisma.moderationResult.findMany({
      where: { creatorId, subjectId: { in: page.map((item) => item.id) } },
      orderBy: { createdAt: 'desc' },
      select: {
        subjectId: true,
        verdict: true,
        categories: true,
        source: true,
        createdAt: true,
      },
    });
    // Newest first above, so the first row for an entry is the verdict that stands — an edit runs
    // through moderation again and writes another.
    const moderation = new Map<string, (typeof judged)[number]>();
    for (const row of judged) {
      if (row.subjectId && !moderation.has(row.subjectId)) moderation.set(row.subjectId, row);
    }

    return {
      items: page.map(({ _count, creatorNotes, ...item }) => ({
        ...item,
        // Same rename as the board: the relation dodges Recommendation's `notes` scalar, the
        // contract does not have to.
        notes: creatorNotes,
        openFlagCount: _count.flags,
        // Null means never judged rather than judged and cleared: a PASS is deliberately not
        // recorded, because almost everything passes and the table would be the largest here.
        moderation: moderation.get(item.id) ?? null,
      })),
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
    const verdict = await this.moderation.review(
      { creatorId, userId: actorUserId, type: 'RECOMMENDATION', id: recommendationId },
      fields.map(([, value]) => value as string),
    );
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
      select: {
        id: true,
        status: true,
        recommendationId: true,
        // The submitter, never the reporter: striking the reporter would make reporting a
        // weapon against the person who used it.
        recommendation: { select: { submittedByUserId: true } },
      },
    });
    if (!flag) throw new NotFoundException();
    if (flag.status !== 'OPEN') {
      // Re-resolving overwrites who handled it and when, and appends an audit row whose `before`
      // is a state the design defines no transition out of.
      throw new ConflictException('That report has already been handled');
    }

    const result = await this.prisma.$transaction(async (tx) => {
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

    // Design §6.4: mod-upheld flags feed the abuse score. RESOLVED means the moderator agreed
    // with the report; DISMISSED means they did not, and must never cost the submitter anything.
    //
    // At most one strike per *entry*, not per report. Flags are one-per-reporter, so an entry
    // with ten reporters produced ten strikes — and ten strikes is the cap, a seven-day lockout
    // from every board the user pays for. Ten throwaway accounts reporting one entry, resolved
    // in good faith one by one, was a denial-of-service against a patron: exactly what §6.4's
    // cap exists to prevent, routed around by making the *count* attacker-controlled.
    if (status === 'RESOLVED') {
      try {
        const alreadyStruck = await this.prisma.moderationAction.count({
          where: { recommendationId: flag.recommendationId, action: 'FLAG_RESOLVED' },
        });
        // This resolution's own audit row is already written, so the first upheld flag sees 1.
        if (alreadyStruck <= 1) {
          await this.abuse.strike(flag.recommendation.submittedByUserId, 'UPHELD_FLAG');
        }
      } catch (error) {
        // A side effect of a decision already recorded; it must not undo the resolution.
        this.logger.warn(`Could not record an upheld-flag strike: ${(error as Error).message}`);
      }
    }
    return result;
  }
}
