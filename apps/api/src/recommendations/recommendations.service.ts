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
import { NOTE_FIELDS } from '../notes/notes.service';
import { AvailabilityService, StoredAvailability } from '../availability/availability.service';
import { ConfigService } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { SubmitRecommendationDto } from './dto/submit-recommendation.dto';
import { PATRON_VISIBLE_STATUSES } from '../moderation/transitions';
import { normalizeTitle } from './normalize-title';
import { ReactionsService, type ReactionCount } from '../reactions/reactions.service';
import {
  BOARD_ONLY_DEFAULTS,
  present,
  recommendationFields,
  visibleLinks,
  withUpvoted,
  type LinkViewer,
} from './recommendation-fields';

import {
  HIDDEN_STATUSES,
  MAX_PAGE,
  afterCursor,
  boardOrdering,
  decodeCursor,
  encodeCursor,
  visibilityWhere,
  type BoardSort,
} from './board-query';

// Re-exported for now so these moves do not drag every importer along with them.
export { BOARD_ONLY_DEFAULTS, present, recommendationFields, visibleLinks, type LinkViewer };
export { visibilityWhere, type BoardSort };

/**
 * What the board projection adds and a single-entry response cannot compute: a parent depends on
 * what else is on the board, and themes arrive with enrichment. Both resolve on the next read;
 * what matters here is that the shape matches, so a prepended card is not a different kind of
 * object from the ones beside it.
 */

/**
 * Renames the `creatorNotes` relation to the `notes` the contract uses, so a single-entry
 * response is the same shape as a board entry. The relation had to dodge Recommendation's own
 * `notes` scalar; the API does not have to inherit that.
 */

// Containment only. RELATED means "similar", and nesting on it would bury unrelated entries.
const NESTING_KINDS: RelationKind[] = ['SEASON_OF', 'SAME_FRANCHISE'];

/** Which canonical media type each binding content class resolves against. */
const MEDIA_TYPES: Record<'MOVIE' | 'SHOW' | 'FRANCHISE', MediaType> = {
  MOVIE: 'MOVIE',
  SHOW: 'TV',
  FRANCHISE: 'COLLECTION',
};

@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly availability: AvailabilityService,
    private readonly reactions: ReactionsService,
  ) {}

  async findOne(
    creator: { id: string; hidePendingFromPublic: boolean; allowReactions?: boolean },
    id: string,
    viewer: { userId: string | null; staffRole: StaffRoleValue | null },
  ) {
    const entry = await this.prisma.recommendation.findFirst({
      where: {
        AND: [{ id, creatorId: creator.id }, visibilityWhere(creator, viewer)],
      },
      select: recommendationFields({ userId: viewer.userId, isStaff: viewer.staffRole !== null }),
    });
    if (!entry) throw new NotFoundException();

    const card = viewer.userId
      ? await withUpvoted(this.prisma, entry, viewer.userId)
      : { ...present(entry), hasUpvoted: false, ...BOARD_ONLY_DEFAULTS };

    // BOARD_ONLY_DEFAULTS is right where a value is genuinely unknown — a fresh submission has no
    // reactions and nobody has looked its availability up — and wrong here, where every one of
    // these is a fact about an entry the board has been rendering in full. A reader following a
    // link to an entry's own page, which is the URL notifications point at, saw strictly less than
    // the summary card they came from.
    //
    // `following` was the one that did more than omit: FollowButton seeds its state from it, so a
    // reader who followed an entry read "Follow" on its page and pressing it followed again. There
    // was no way to stop following from the page the notification links to.
    const titleId = entry.title?.id ?? null;
    const [availability, themes, reactions, following] = await Promise.all([
      this.availabilityFor(titleId),
      titleId ? this.themesFor([titleId], creator.id) : null,
      // Empty when the board has reactions off, rather than fetched and hidden — the rule the
      // board list already follows: a count nobody may see is a query nobody needs.
      creator.allowReactions ? this.reactions.forRecommendations([entry.id], viewer.userId) : null,
      this.followsEntry(entry.id, viewer.userId),
    ]);

    // `parentId` stays null, and that is not the same omission. Nesting is a projection over
    // whatever else is on the board right now, so there is no answer for one entry read alone.
    return {
      ...card,
      availability,
      themes: (titleId && themes?.get(titleId)) || [],
      reactions: reactions?.get(entry.id) ?? [],
      following,
    };
  }

  /** Whether *this* reader asked to hear about this entry; false for a signed-out one. */
  private async followsEntry(recommendationId: string, userId: string | null): Promise<boolean> {
    if (!userId) return false;
    const follow = await this.prisma.entryFollow.findUnique({
      where: { userId_recommendationId: { userId, recommendationId } },
      select: { userId: true },
    });
    return follow !== null;
  }

  /**
   * The same bargain the board makes, for one title.
   *
   * Never blocks on the upstream and never fails the read: a cold entry renders without badges
   * and the refresh this queues lands before the next one. `forTitles` rather than `forTitle`
   * precisely because `forTitle` waits for the provider — right for the endpoint a caller asks
   * with, wrong for a page render.
   */
  private async availabilityFor(titleId: string | null): Promise<StoredAvailability | null> {
    if (!titleId) return null;
    try {
      const region = this.config.get('AVAILABILITY_REGION_DEFAULT');
      return (await this.availability.forTitles([titleId], region)).get(titleId) ?? null;
    } catch (error) {
      this.logger.warn(`Availability lookup failed for entry title ${titleId}: ${String(error)}`);
      return null;
    }
  }

  async setCreatorPick(creatorId: string, id: string, isCreatorPick: boolean): Promise<void> {
    const { count } = await this.prisma.recommendation.updateMany({
      where: { id, creatorId },
      data: { isCreatorPick },
    });
    if (count === 0) throw new NotFoundException();
  }

  /**
   * Maps each page title to the recommendation on this page that contains it.
   *
   * Only containment kinds nest — RELATED means "similar", and nesting on it would bury
   * unrelated entries under each other. Resolved within the page, so a child never nests under
   * something the viewer cannot see: the page has already been filtered by visibility.
   */
  private async parentsFor(
    page: Array<{ id: string; titleId: string | null; groupHeadId?: string | null }>,
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

  async list(
    creator: { id: string; hidePendingFromPublic: boolean; allowReactions?: boolean },
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

    const isStaff = viewer.staffRole !== null;
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
        ...recommendationFields({ userId: viewer.userId, isStaff }),
        upvoteCount: true,
        weightedScore: true,
        createdAt: true,
        // Selected for the availability and relation joins, then dropped from the response.
        titleId: true,
        // Whether *this* viewer upvoted. Without it a client cannot render the control's state
        // truthfully, and an optimistic toggle guesses the direction wrong.
        ...(viewerUserId
          ? {
              upvotes: { where: { userId: viewerUserId }, select: { id: true }, take: 1 },
              // Whether *this* viewer asked to hear about this entry. Without it the control
              // forgets on every reload and the feature looks broken rather than unset.
              followers: {
                where: { userId: viewerUserId },
                select: { userId: true },
                take: 1,
              },
            }
          : {}),
      },
    })) as Array<{
      id: string;
      upvoteCount: number;
      weightedScore: number;
      isCreatorPick: boolean;
      manualRank: number | null;
      groupHeadId: string | null;
      createdAt: Date;
      titleId: string | null;
      links?: Array<{
        id: string;
        url: string;
        label: string | null;
        status: string;
        isPreferred: boolean;
      }>;
      upvotes?: Array<{ id: string }>;
      followers?: Array<{ userId: string }>;
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
    // One query for the page, like availability above. Empty when the board has reactions off,
    // rather than fetched and hidden — a count nobody may see is a query nobody needs.
    const reactions = creator.allowReactions
      ? await this.reactions.forRecommendations(
          page.map((item) => item.id),
          viewerUserId,
        )
      : new Map<string, ReactionCount[]>();

    return {
      items: page.map(({ upvotes, followers, titleId, groupHeadId, ...item }) => ({
        ...present(item),
        hasUpvoted: (upvotes ?? []).length > 0,
        following: (followers ?? []).length > 0,
        // Null for an external link, which has no canonical identity to look up.
        availability: (titleId && availability.get(titleId)) || null,
        // Nesting is a *per-board* projection, not a stored fact: whether an entry has a parent
        // depends on what else is on this board, which changes with every submission and every
        // status change.
        // A head chosen by staff wins over one TMDB implies: the explicit decision is the whole
        // point, and it is the only one that can reach an entry with no catalogue title.
        parentId: groupHeadId ?? ((titleId && parents.get(titleId)) || null),
        themes: (titleId && themes.get(titleId)) || [],
        // Never an input to the ordering above — see the Reaction model.
        reactions: reactions.get(item.id) ?? [],
      })),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }
}
