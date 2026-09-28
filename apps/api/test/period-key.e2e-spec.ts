import { periodKeyFor } from '../src/tokens/period-key';

/**
 * A period is a UTC calendar month.
 *
 * Not the reader's real Patreon renewal date: the sync does not fetch one, Patreon charges
 * different patrons on different days, and a per-reader boundary means a per-reader scheduler.
 * See the design — a calendar month is a day or two "wrong" for most readers and understandable
 * by all of them.
 */
describe('periodKeyFor', () => {
  it('reads a month as YYYY-MM', () => {
    expect(periodKeyFor(new Date('2026-09-24T12:00:00Z'))).toBe('2026-09');
  });

  it('pads a single-digit month, so the key sorts as a string', () => {
    // '2026-9' would sort after '2026-10', which makes any ordered read of the ledger wrong.
    expect(periodKeyFor(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
  });

  it("uses UTC, not the server's local time", () => {
    // 23:00 on 31 December in UTC-5 is already January in UTC. A server that moved timezones —
    // or two servers in different ones — must agree on which period a grant belongs to, or the
    // unique constraint stops preventing the double grant it exists for.
    expect(periodKeyFor(new Date('2027-01-01T04:00:00Z'))).toBe('2027-01');
    expect(periodKeyFor(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
  });

  it('turns the year over at the right instant', () => {
    expect(periodKeyFor(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12');
    expect(periodKeyFor(new Date('2027-01-01T00:00:00.000Z'))).toBe('2027-01');
  });
});
