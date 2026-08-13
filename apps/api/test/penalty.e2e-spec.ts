import { DECAY_AFTER_MS, MAX_PENALTY_MS, penaltyFor } from '../src/abuse/penalty';

const HOUR = 60 * 60 * 1000;

describe('penaltyFor', () => {
  it('costs nothing for a first strike', () => {
    // One blocked word is a mistake, not a campaign. The record exists so the *next* one counts.
    expect(penaltyFor(1)).toBe(0);
  });

  it('treats a zero or negative count as no penalty', () => {
    expect(penaltyFor(0)).toBe(0);
    expect(penaltyFor(-1)).toBe(0);
  });

  it('starts at an hour and doubles', () => {
    expect(penaltyFor(2)).toBe(HOUR);
    expect(penaltyFor(3)).toBe(2 * HOUR);
    expect(penaltyFor(4)).toBe(4 * HOUR);
  });

  it('caps rather than growing forever', () => {
    // Design §6.4: no permanent lockouts, because a lockout is a denial-of-service someone else
    // can trigger on your behalf.
    expect(penaltyFor(50)).toBe(MAX_PENALTY_MS);
    expect(penaltyFor(500)).toBe(MAX_PENALTY_MS);
    expect(penaltyFor(Number.MAX_SAFE_INTEGER)).toBe(MAX_PENALTY_MS);
  });

  it('never returns a negative or fractional duration', () => {
    for (let n = -5; n <= 40; n += 1) {
      expect(penaltyFor(n)).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(penaltyFor(n))).toBe(true);
    }
  });

  it('is monotonic', () => {
    for (let n = 1; n < 40; n += 1) {
      expect(penaltyFor(n + 1)).toBeGreaterThanOrEqual(penaltyFor(n));
    }
  });

  it('caps at a week, which a determined abuser can wait out', () => {
    expect(MAX_PENALTY_MS).toBe(7 * 24 * HOUR);
  });

  it('decays over a period shorter than the cap, so strikes can actually clear', () => {
    expect(DECAY_AFTER_MS).toBeLessThan(MAX_PENALTY_MS);
  });
});
