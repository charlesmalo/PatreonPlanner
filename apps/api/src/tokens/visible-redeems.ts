import type { LinkViewer } from '../recommendations/links.service';

/**
 * The unconsumed redeems on an entry, and who may read them.
 *
 * The note is not decoration on this feature — it *is* the instruction. Nothing in this system
 * models an episode, so "the next one" only exists as a sentence a patron wrote, and a creator
 * who cannot read it has been handed a Priority marker with no way to learn what it asks for.
 * The count alone answers "somebody wants this sooner"; only the note answers "which part".
 *
 * Staff read every note on the entry, because acting on them is the job. Everyone else reads
 * only their own, which is the same rule candidate links follow and for the same reason: your
 * own words are yours to see, and a stranger's request is between them and the creator.
 * A signed-out reader gets none, expressed as an empty `in` rather than a sentinel id. The
 * sentinel was `{ id: '' }`, and an empty string is not a UUID: Prisma raised P2023, the filter
 * turned it into a 404, and **the entire board went missing for every signed-out visitor** on
 * any board with tokens switched on. A filter meant to hide five words took the page down. An
 * empty `in` needs no value to be parseable and matches nothing by construction.
 */
export function visibleRedeems(viewer: LinkViewer) {
  const mine = viewer.userId === null ? { id: { in: [] as string[] } } : { userId: viewer.userId };
  return {
    // Consumed redeems are history, not a request: once the entry has played, the note describes
    // something already done and showing it beside a fresh one would read as still outstanding.
    where: viewer.isStaff ? { consumedAt: null } : { consumedAt: null, ...mine },
    select: {
      id: true,
      note: true,
      createdAt: true,
      user: { select: { id: true, fullName: true, avatarUrl: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  };
}
