export interface PatreonTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface PatreonMembership {
  campaignId: string;
  patreonTierIds: string[];
  amountCents: number;
  isActivePatron: boolean;
}

export interface PatreonTier {
  patreonTierId: string;
  title: string;
  amountCents: number;
  order: number;
}

export interface PatreonCampaign {
  campaignId: string;
  displayName: string;
  tiers: PatreonTier[];
}

/**
 * Who somebody is, without what they support.
 *
 * Separate from `PatreonIdentity` for one reason, and it is a safety reason rather than a tidiness
 * one: the login fallback can only obtain this much, and passing a memberships list it did not
 * actually read to `applyIdentity` would deactivate every membership the reader has. Having no
 * `memberships` field at all makes that a compile error instead of something to remember.
 */
export interface PatreonProfile {
  patreonUserId: string;
  fullName: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface PatreonIdentity extends PatreonProfile {
  memberships: PatreonMembership[];
}
