import type { Recommendation } from '../api/types';

/**
 * Which entries in this column an entry may be grouped into.
 *
 * Mirrors the API's refusals so the menu never offers a move the server answers 409 to — the same
 * bargain `StatusControl` makes with the transition map. A drift here costs a clear error
 * message, not safety: the server is what enforces the shape.
 *
 * The API refuses three things (`GroupingService.group`):
 *
 * - grouping an entry into itself
 * - grouping an entry that **already carries a group** — one level, in both directions
 * - grouping into an entry that is **already inside** one
 *
 * The second is why `hasMembers` is a parameter rather than something read off the entry: an
 * entry's children are a per-board projection the card does not carry, so only the caller holding
 * the built tree knows. The third keys on `parentSource === 'STAFF'` rather than on `parentId`,
 * because a catalogue-implied child is not in a group at all and **is** a legal target.
 */
export function groupTargets(
  entry: Recommendation,
  column: Recommendation[],
  hasMembers: (id: string) => boolean,
): Recommendation[] {
  // Nothing at all is offered for an entry that heads a group: the API refuses every target, so
  // a menu of them would be a list of refusals.
  if (hasMembers(entry.id)) return [];
  return column.filter(
    (candidate) => candidate.id !== entry.id && candidate.parentSource !== 'STAFF',
  );
}
