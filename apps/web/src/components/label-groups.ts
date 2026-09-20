/**
 * The filter a reader has built: an OR of groups, each an AND of labels.
 *
 * Pure and separate from the component because every one of these operations has an edge the UI
 * must not be allowed to produce — an empty group, a label in two places, a group of one that
 * should have become an ordinary chip.
 */
export function encodeGroups(groups: string[][]): string {
  return groups.map((group) => group.join('|')).join(',');
}

/**
 * Tolerant on purpose: this value comes from `localStorage`, which a reader can edit and an older
 * build may have written. Anything unreadable is dropped rather than thrown — a board that cannot
 * paint because its filter will not parse is worse than one that paints unfiltered.
 */
export function decodeGroups(raw: string): string[][] {
  return raw
    .split(',')
    .map((group) => group.split('|').filter((id) => id.length > 0))
    .filter((group) => group.length > 0);
}

/** Wherever it currently sits. Dropping the group it empties keeps `[[]]` unrepresentable. */
function without(groups: string[][], id: string): string[][] {
  return groups
    .map((group) => group.filter((member) => member !== id))
    .filter((group) => group.length > 0);
}

export function toggleLabel(groups: string[][], id: string): string[][] {
  return groups.some((group) => group.includes(id)) ? without(groups, id) : [...groups, [id]];
}

export function combine(groups: string[][], id: string, intoIndex: number): string[][] {
  const target = groups[intoIndex];
  if (!target || target.includes(id)) return groups;
  // Removed first, so a label never appears twice across the filter — which means the target may
  // have shifted index, and `without` rebuilds every array so it is no longer the same object
  // either. It is found by a member that survives: `anchor` cannot be `id`, because a target
  // containing `id` returned above.
  //
  // Matching on identity here was the plan's original text, and it silently *lost* the label:
  // the removal happened, the re-add never matched, and the filter came back one label shorter.
  const anchor = target[0];
  const remaining = without(groups, id);
  return remaining.map((group) => (group.includes(anchor) ? [...group, id] : group));
}

/** `magnetIndex` is the gap after that member: 0 splits between members 0 and 1. */
export function splitAt(groups: string[][], groupIndex: number, magnetIndex: number): string[][] {
  const group = groups[groupIndex];
  if (!group || magnetIndex < 0 || magnetIndex >= group.length - 1) return groups;
  return [
    ...groups.slice(0, groupIndex),
    group.slice(0, magnetIndex + 1),
    group.slice(magnetIndex + 1),
    ...groups.slice(groupIndex + 1),
  ];
}

export function removeGroup(groups: string[][], groupIndex: number): string[][] {
  return groups.filter((_, index) => index !== groupIndex);
}
