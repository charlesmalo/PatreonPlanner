export type Capability = 'VIEW' | 'UPVOTE' | 'SUBMIT' | 'MODERATE';

export type ViewVisibilityValue = 'PUBLIC' | 'ANY_PATREON_USER' | 'SUBSCRIBERS_ONLY';

export interface Viewer {
  isAuthenticated: boolean;
  isActivePatron: boolean;
  /**
   * What the viewer actually pledges to this creator, from Patreon's entitled amount — not the
   * list price of the tier we mirrored. Gates compare this rather than Tier.order: design §14
   * leaves tier ordering unverified, while the pledge is the value a patron commits. `order` is
   * retained for display only.
   */
  pledgeAmountCents: number | null;
  isStaff: boolean;
}

export interface Policy {
  viewVisibility: ViewVisibilityValue;
  submitMinTierAmountCents: number | null;
  upvoteMinTierAmountCents: number | null;
}

/**
 * The whole of design §4's capability table, deliberately pure: no Prisma, no Redis, nothing to
 * stub. Authorization rules are the part most worth exhaustive testing, and they should be
 * testable without a database standing behind them.
 */
export function can(capability: Capability, viewer: Viewer, policy: Policy): boolean {
  // Design §3: moderation power derives only from a CreatorStaff row, so no amount of pledging
  // reaches it. Plan 06's staff management is OWNER-only and will need StaffRole here, not just
  // the boolean.
  if (capability === 'MODERATE') return viewer.isAuthenticated && viewer.isStaff;

  // Staff bypass the patron gates: a creator's own moderators must be able to work the board
  // they moderate without also pledging to it.
  if (viewer.isAuthenticated && viewer.isStaff) return true;

  switch (capability) {
    case 'VIEW':
      return canView(viewer, policy);
    case 'UPVOTE':
      return meetsPledge(viewer, policy.upvoteMinTierAmountCents);
    case 'SUBMIT':
      return meetsPledge(viewer, policy.submitMinTierAmountCents);
  }
}

function canView(viewer: Viewer, policy: Policy): boolean {
  switch (policy.viewVisibility) {
    case 'PUBLIC':
      return true;
    case 'ANY_PATREON_USER':
      return viewer.isAuthenticated;
    case 'SUBSCRIBERS_ONLY':
      return viewer.isActivePatron;
  }
}

function meetsPledge(viewer: Viewer, minimumCents: number | null): boolean {
  // An active pledge is required even when the creator sets no minimum, so writing is never
  // open to a merely logged-in visitor.
  if (!viewer.isActivePatron) return false;
  return (viewer.pledgeAmountCents ?? 0) >= (minimumCents ?? 0);
}
