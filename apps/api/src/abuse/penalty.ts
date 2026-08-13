const HOUR_MS = 60 * 60 * 1000;

/**
 * Design §6.4: **no permanent lockouts**. A cap is not leniency — an uncapped penalty is a
 * denial-of-service anyone can trigger on someone else's behalf by provoking strikes.
 */
export const MAX_PENALTY_MS = 7 * 24 * HOUR_MS;

/** How long a user must go without a new strike before losing one. */
export const DECAY_AFTER_MS = 24 * HOUR_MS;

/**
 * The escalation curve from design §6.4: `1h → 2h → 4h → …`, capped.
 *
 * Pure, and stored as a *count* rather than a duration, so the curve can change without a
 * migration — a persisted duration would freeze the policy at the moment it was written.
 *
 * The first strike costs nothing. One blocked word is a mistake, not a campaign; the record
 * exists so that the next one counts.
 */
export function penaltyFor(strikeCount: number): number {
  if (strikeCount < 2) return 0;
  // Exponent is bounded before the shift, not after: 2 ** 60 is finite but meaningless, and
  // relying on Math.min to tidy up afterwards invites a precision surprise.
  const doublings = Math.min(strikeCount - 2, 40);
  return Math.min(HOUR_MS * 2 ** doublings, MAX_PENALTY_MS);
}
