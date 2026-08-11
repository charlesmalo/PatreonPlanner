/**
 * De-duplication key. Lowercases, strips punctuation and collapses whitespace so "The Matrix!"
 * and "the  matrix" resolve to the same board entry — design §5 wants a resubmit to find the
 * existing entry rather than create a second one.
 */
export function normalizeTitle(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
