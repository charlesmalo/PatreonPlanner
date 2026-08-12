import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { MediaType, Prisma, RecommendationStatus, RelationKind } from '@prisma/client';
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
 * Design §7: staff read the whole board including the bin, patrons read only the visible
 * statuses — minus pending entries when the creator hides them, except their own.
 */
function visibilityWhere(
  creator: { hidePendingFromPublic: boolean },
  viewer: { userId: string | null; isStaff: boolean },
): Prisma.RecommendationWhereInput {
  if (viewer.isStaff) return {};
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

interface BoardCursor {
  upvoteCount: number;
  createdAt: Date;
  id: string;
}

function encodeCursor(row: { upvoteCount: number; createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ u: row.upvoteCount, c: row.createdAt.toISOString(), i: row.id }),
  ).toString('base64url');
}

function decodeCursor(raw: string | undefined): BoardCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      u: number;
      c: string;
      i: string;
    };
    const createdAt = new Date(parsed.c);
    if (typeof parsed.u !== 'number' || Number.isNaN(createdAt.getTime()) || !parsed.i) {
      throw new Error('malformed');
    }
    return { upvoteCount: parsed.u, createdAt, id: parsed.i };
  } catch {
    // A cursor we did not mint is a client bug, not an empty board.
    throw new BadRequestException('Invalid cursor');
  }
}

// Explicit select: the submitter is a User row carrying an email and Patreon id, neither of
// which belongs on a public board.
const RECOMMENDATION_FIELDS = {
  id: true,
  type: true,
  customTitle: true,
  description: true,
  status: true,
  upvoteCount: true,
  createdAt: true,
  title: {
    // `id` is what GET /catalog/titles/:id/availability keys on. Without it the endpoint is
    // unreachable: no response anywhere exposed the catalogue row's id.
    select: { id: true, tmdbId: true, mediaType: true, name: true, year: true, posterPath: true },
  },
  links: { select: { url: true, label: true } },
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
  ) {}

  /**
   * The returned recommendation carries hasUpvoted like the board's does. Without it a client
   * prepending the result renders a card in a different shape from every other card — which is
   * precisely what the end-to-end suite caught.
   */
  async submit(creatorId: string, userId: string, dto: SubmitRecommendationDto) {
    // Rate limit first: moderation is the expensive stage, and a flood must not be able to
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
      throw new HttpException('Too many submissions', HttpStatus.TOO_MANY_REQUESTS);
    }

    // Link labels and URLs are user-controlled and rendered on the board, so they go through
    // the pipeline too. Reviewing only title and description left the whole content-safety
    // control bypassable by putting the text in a label.
    const moderation = await this.moderation.review([
      dto.customTitle,
      dto.description,
      ...(dto.links?.flatMap((link) => [link.label, link.url]) ?? []),
      // Item text is exactly where a submitter would route around a title-only check.
      ...(dto.items?.flatMap((item) => [item.customTitle, item.note]) ?? []),
    ]);
    if (moderation.verdict === 'BLOCK') {
      // Generic to the caller, specific in the log: design §9 wants no probing of the rules.
      this.logger.warn(`Blocked submission from user ${userId} to creator ${creatorId}`);
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
      return { duplicate: true as const, recommendation: await this.withUpvoted(existing, userId) };
    }

    try {
      return await this.create(
        creatorId,
        userId,
        dto,
        displayTitle,
        normalizedTitle,
        title?.id ?? null,
        items,
      );
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
        return { duplicate: true as const, recommendation: await this.withUpvoted(winner, userId) };
      }
      throw error;
    }
  }

  /** A duplicate may already be upvoted by this viewer; a fresh one never is. */
  private async withUpvoted<T extends { id: string }>(recommendation: T, userId: string) {
    const upvote = await this.prisma.upvote.findUnique({
      where: { recommendationId_userId: { recommendationId: recommendation.id, userId } },
      select: { id: true },
    });
    return { ...recommendation, hasUpvoted: upvote !== null };
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
      // Refreshed on each binding: posters and overviews change upstream.
      update: { name: result.name, year: result.year, posterPath: result.posterPath },
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
    return { duplicate: false as const, recommendation: { ...recommendation, hasUpvoted: false } };
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
        update: { name: result.name, year: result.year, posterPath: result.posterPath },
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
    viewer: { userId: string | null; isStaff: boolean },
    themeId?: string,
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
          ...(cursor
            ? [
                {
                  OR: [
                    { upvoteCount: { lt: cursor.upvoteCount } },
                    {
                      upvoteCount: cursor.upvoteCount,
                      createdAt: { lt: cursor.createdAt },
                    },
                    {
                      upvoteCount: cursor.upvoteCount,
                      createdAt: cursor.createdAt,
                      id: { lt: cursor.id },
                    },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ upvoteCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
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
      createdAt: Date;
      titleId: string | null;
      upvotes?: Array<{ id: string }>;
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
      items: page.map(({ upvotes, titleId, ...item }) => ({
        ...item,
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
