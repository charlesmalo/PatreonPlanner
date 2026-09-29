import { Prisma } from '@prisma/client';
import { NOTE_FIELDS } from '../notes/notes.service';
import type { PrismaService } from '../prisma/prisma.service';
import { visibleLinks, type LinkViewer } from './links.service';
import { visibleRedeems } from '../tokens/visible-redeems';
import type { ReactionCount } from '../reactions/reactions.service';

/**
 * How an entry is shaped on its way out.
 *
 * Its own module because three call paths build a card — the board, a search hit, and the
 * response to a submission — and a client renders all three with the same component. When the
 * projection lived inside the board service they drifted: `candidateLinks` reached the board and
 * not the other two, and the test that caught it was the one asserting a submitted entry has the
 * same keys a board entry has.
 */

export const BOARD_ONLY_DEFAULTS = {
  availability: null,
  parentId: null,
  // Null for the same reason `parentId` is: nesting is a projection over the rest of the board,
  // so neither has an answer for one entry read on its own.
  parentSource: null as 'STAFF' | 'CATALOGUE' | null,
  themes: [] as Array<{ id: string; name: string }>,
  // A freshly submitted entry and a search hit both have none, and a client rendering a card
  // from either needs the same fields the board's card has.
  reactions: [] as ReactionCount[],
  // A freshly submitted entry is not followed by definition — nobody has had the chance. Search
  // overrides this with the real answer, the same way it does for hasUpvoted.
  following: false,
};

type SelectedLink = { id: string; url: string; label: string | null; isPreferred: boolean } & {
  status: string;
};

export function present<
  T extends {
    creatorNotes?: unknown[];
    groupHeadId?: string | null;
    links?: SelectedLink[];
    redeems?: unknown[];
    unconsumedRedeems?: number;
  },
>(row: T) {
  // `groupHeadId` is internal: the contract exposes `parentId`, which is the same answer whether
  // the head was chosen by staff or implied by the catalogue. `creatorNotes` is a schema artefact
  // — the model had to dodge Recommendation's own `notes` scalar.
  const { creatorNotes, groupHeadId, links, ...rest } = row;
  // Published on the card, candidates alongside for the staff who decide. Partitioned in the one
  // presenter every path goes through: a reader who is not staff never had a candidate selected,
  // so this splits an already-safe list rather than being the thing that keeps it safe.
  const strip = ({ status, ...link }: SelectedLink) => link;
  return {
    ...rest,
    // The count and the notes are the same feature, so one decision governs both: if the
    // projection did not expose `redeems`, the creator has tokens off and the count goes too.
    // Tying them here rather than at each call site is what stops them drifting apart — the
    // count leaked on its own once, drawing a Priority badge on a board whose settings said the
    // feature was off, because only the notes were gated.
    //
    // The field is always *present* and numeric. A client types it as a required number, and an
    // absent one would read as `undefined > 0` — accidentally correct, and one refactor from a
    // crash.
    unconsumedRedeems: row.redeems === undefined ? 0 : (row.unconsumedRedeems ?? 0),
    links: (links ?? []).filter((link) => link.status === 'PUBLISHED').map(strip),
    candidateLinks: (links ?? []).filter((link) => link.status === 'CANDIDATE').map(strip),
    notes: creatorNotes ?? [],
  };
}

// Explicit select: the submitter is a User row carrying an email and Patreon id, neither of
// which belongs on a public board.
export { visibleLinks, type LinkViewer };

/**
 * The viewer, plus whether this board's creator has redeem tokens switched on.
 *
 * Optional and defaulting to off, deliberately: a call site that forgets it hides the feature
 * rather than exposing it. The failure of omission should be an absent badge, never a patron's
 * words shown on a board whose settings say the feature is off.
 */
export type EntryViewer = LinkViewer & { tokensEnabled?: boolean };

export const recommendationFields = (viewer: EntryViewer) =>
  ({
    id: true,
    type: true,
    customTitle: true,
    description: true,
    status: true,
    upvoteCount: true,
    weightedScore: true,
    isCreatorPick: true,
    // Read by the board's ordering and rendered as the Priority marker. Zero on every board that
    // never enables tokens, so it changes nothing there.
    unconsumedRedeems: true,
    // The notes behind that count. Staff read all of them, a patron reads only their own — see
    // `visibleRedeems`.
    //
    // Omitted entirely when the creator has the feature off, which is also what tells `present`
    // to zero the count above. Retained in the database either way: disabling hides, it does not
    // destroy, and re-enabling brings back exactly what was there.
    ...(viewer.tokensEnabled ? { redeems: visibleRedeems(viewer) } : {}),
    manualRank: true,
    // Read for the parent projection below, then dropped from the response — the contract exposes
    // `parentId`, whether the head was chosen by staff or implied by the catalogue.
    groupHeadId: true,
    createdAt: true,
    title: {
      // `id` is what GET /catalog/titles/:id/availability keys on. Without it the endpoint is
      // unreachable: no response anywhere exposed the catalogue row's id.
      select: { id: true, tmdbId: true, mediaType: true, name: true, year: true, posterPath: true },
    },
    // A candidate is a claim waiting for a human, and rendering someone else's would carry the
    // creator's implicit endorsement — which is the whole reason it waits.
    links: visibleLinks(viewer),
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
  }) satisfies Prisma.RecommendationSelect;

/**
 * A card, with this viewer's own upvote resolved.
 *
 * Here rather than on a service because both the board read and the submission path need it, and
 * the alternative was one of them importing the other. Takes its client explicitly so a caller
 * inside a transaction can pass that instead.
 */
export async function withUpvoted<T extends { id: string; creatorNotes?: unknown[] }>(
  prisma: PrismaService,
  recommendation: T,
  userId: string,
) {
  const upvote = await prisma.upvote.findUnique({
    where: { recommendationId_userId: { recommendationId: recommendation.id, userId } },
    select: { id: true },
  });
  return { ...present(recommendation), hasUpvoted: upvote !== null, ...BOARD_ONLY_DEFAULTS };
}
