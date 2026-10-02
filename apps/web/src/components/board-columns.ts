/**
 * The board's columns, and what each is called.
 *
 * Its own module because two surfaces need the mapping and they must not drift: the board draws
 * one column at a time, and search returns matches from all four at once and has to say which
 * one each result is sitting in.
 */
export const COLUMNS: Array<[string, string]> = [
  ['PENDING', 'Suggestions'],
  ['ACCEPTED', 'Accepted'],
  ['ACTIVE', 'Now Playing'],
  ['COMPLETED', 'Completed'],
];

const BY_STATUS = new Map(COLUMNS);

/**
 * Falls back to the raw status rather than to empty. A result whose column this does not know is
 * still a real entry on the board, and labelling it "" would read as a rendering fault.
 */
export function columnLabel(status: string): string {
  return BY_STATUS.get(status) ?? status;
}
