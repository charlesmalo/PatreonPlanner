import { PatreonCampaign, PatreonIdentity, PatreonProfile, PatreonTokens } from './patreon.types';

export const PATREON_CLIENT = Symbol('PATREON_CLIENT');

export interface PatreonClient {
  buildAuthorizationUrl(params: { state: string; codeChallenge: string }): string;
  exchangeCode(code: string, codeVerifier: string): Promise<PatreonTokens>;
  refreshTokens(refreshToken: string): Promise<PatreonTokens>;
  fetchIdentity(accessToken: string): Promise<PatreonIdentity>;
  /**
   * Who they are, without asking what they support.
   *
   * Exists because `fetchIdentity` is reported to time out for readers with many memberships —
   * server-side, and not helped by paging or trimming fields — which would otherwise mean the
   * people supporting the most creators cannot sign in at all. This call omits the include that
   * causes it, so it is enough to identify somebody and let them in.
   */
  fetchProfile(accessToken: string): Promise<PatreonProfile>;
  fetchOwnedCampaigns(accessToken: string): Promise<PatreonCampaign[]>;
}
