/**
 * De-duplication key. Lowercases, strips punctuation and collapses whitespace so "The Matrix!"
 * and "the  matrix" resolve to the same board entry.
 *
 * Letters and digits are kept in ANY script. An ASCII-only class collapsed every Japanese,
 * Korean, Chinese, Cyrillic, Arabic and emoji title to the empty string, which then matched
 * every other such title — so the second patron to suggest anything non-Latin was handed an
 * unrelated entry as their "duplicate". Design §5 wants cross-language matching, not a board
 * that whole language communities cannot submit to.
 */
export function normalizeTitle(input: string): string {
  return (
    input
      .normalize('NFKD')
      // Drop combining marks so accented letters fold to their base rather than splitting.
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  );
}
