import type { Notification } from './types';

/**
 * What each kind of notification is called when a reader is choosing which ones to look at.
 *
 * The type matters more than the copy. `Record<Notification['type'], string>` is exhaustive in
 * both directions: a kind added to the union without a label here fails to compile, and a label
 * for a kind that no longer exists fails too. That is the guarantee this module exists to
 * provide — the page it serves used to keep its own copy of the union and one hand-written
 * `<option>` per value, so a sixth kind typechecked cleanly and arrived with no way to filter for
 * it. `scripts/audit-enum-coverage.mjs` would not have caught it either: that check compares
 * `api/types.ts` to the Prisma enum and deliberately looks no further, which leaves everything
 * downstream of `types.ts` on its own.
 *
 * Wording is the reader's, not the schema's: ENTRY_MOVED is "boards you follow" because that is
 * why it was sent, and nobody has a mental category called "entry moved".
 */
const FILTER_LABELS: Record<Notification['type'], string> = {
  ENTRY_FLAGGED: 'Reports',
  ENTRY_STATUS_CHANGED: 'Status changes',
  ENTRY_MOVED: 'Boards you follow',
  TICKET_RAISED: 'Messages to moderators',
  TICKET_RESOLVED: 'Answers to your messages',
};

/**
 * The filters to offer, in the order they are offered. Insertion order above is the display
 * order, which puts reports first because that is the one a moderator reaches for.
 */
export const NOTIFICATION_FILTERS = Object.entries(FILTER_LABELS) as Array<
  [Notification['type'], string]
>;
