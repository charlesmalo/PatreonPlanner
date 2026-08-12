import type { RecommendationStatus } from '@prisma/client';

/**
 * Design §7's lifecycle diagram as data. Anything not listed is illegal — the map is a whitelist
 * so a new status is unreachable until someone decides where it connects, rather than silently
 * becoming a legal destination from everywhere.
 */
const TRANSITIONS: Record<RecommendationStatus, RecommendationStatus[]> = {
  PENDING: ['ACCEPTED', 'REJECTED', 'DELETED'],
  ACCEPTED: ['ACTIVE', 'REJECTED', 'DELETED'],
  ACTIVE: ['COMPLETED', 'REJECTED', 'DELETED'],
  COMPLETED: ['REJECTED', 'DELETED'],
  // Restoration lands on PENDING rather than the previous status: the row does not record where
  // it came from, and inventing a destination would be a guess written to an audit log.
  REJECTED: ['PENDING', 'DELETED'],
  DELETED: ['PENDING'],
};

export function isLegalTransition(from: RecommendationStatus, to: RecommendationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Fail closed: a status is staff-only until it is named here. */
export const PATRON_VISIBLE_STATUSES: RecommendationStatus[] = [
  'PENDING',
  'ACCEPTED',
  'ACTIVE',
  'COMPLETED',
];
