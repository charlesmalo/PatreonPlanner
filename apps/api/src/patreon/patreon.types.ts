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

export interface PatreonIdentity {
  patreonUserId: string;
  fullName: string | null;
  email: string | null;
  avatarUrl: string | null;
  memberships: PatreonMembership[];
}
