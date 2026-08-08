import { PatreonIdentity, PatreonTokens } from './patreon.types';

export const PATREON_CLIENT = Symbol('PATREON_CLIENT');

export interface PatreonClient {
  buildAuthorizationUrl(params: { state: string; codeChallenge: string }): string;
  exchangeCode(code: string, codeVerifier: string): Promise<PatreonTokens>;
  refreshTokens(refreshToken: string): Promise<PatreonTokens>;
  fetchIdentity(accessToken: string): Promise<PatreonIdentity>;
}
