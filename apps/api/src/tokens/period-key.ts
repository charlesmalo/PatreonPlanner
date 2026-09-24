/**
 * Which grant period an instant belongs to, as `YYYY-MM` in UTC.
 *
 * A period is this product's own calendar month, not the reader's Patreon renewal date. The sync
 * does not fetch a renewal date, Patreon charges different patrons on different days, and a
 * per-reader boundary would mean a per-reader scheduler. A calendar month is a day or two "wrong"
 * for most readers and understandable by all of them — see the design for what that costs a
 * reader who joins on the 28th.
 *
 * **UTC, always.** This string is half of the unique constraint that stops a reader being granted
 * twice for one period. Two servers in different timezones, or one that moves, would disagree
 * about which period an instant belongs to — and a constraint the writers disagree about is not a
 * constraint.
 *
 * A string rather than a date range because the collision it must prevent is exact equality, and
 * `2026-09` compares, sorts and reads correctly. A range would need an exclusion constraint most
 * readers of this schema would not recognise.
 */
export function periodKeyFor(at: Date): string {
  const year = at.getUTCFullYear();
  // getUTCMonth is zero-based, and the pad is what makes the key sort as a string: '2026-9'
  // would sort after '2026-10' and make any ordered read of the ledger wrong.
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}
