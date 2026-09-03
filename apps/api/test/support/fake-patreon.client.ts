import { PatreonClient } from '../../src/patreon/patreon.client';
import {
  PatreonCampaign,
  PatreonIdentity,
  PatreonProfile,
  PatreonTokens,
} from '../../src/patreon/patreon.types';

/**
 * Records what it was called with so tests can assert the PKCE verifier actually reached the
 * exchange, and returns fixed data so assertions stay deterministic. Every auth test runs
 * against this — no network, no real Patreon credentials.
 */
export class FakePatreonClient implements PatreonClient {
  public exchangeCalls: Array<{ code: string; codeVerifier: string }> = [];
  public identity: PatreonIdentity = {
    patreonUserId: 'patreon-user-1',
    fullName: 'Ada Lovelace',
    email: 'ada@example.com',
    avatarUrl: 'https://example.com/ada.png',
    memberships: [],
  };
  public exchangeShouldFail = false;
  public refreshCalls: string[] = [];
  public refreshShouldFail = false;
  public campaigns: PatreonCampaign[] = [];
  public campaignsShouldFail = false;
  /** Simulates the timeout Patreon is reported to return for readers with many memberships. */
  public identityShouldFail = false;
  /** The fallback failing too, which must still refuse the login rather than invent a reader. */
  public profileShouldFail = false;

  buildAuthorizationUrl({
    state,
    codeChallenge,
  }: {
    state: string;
    codeChallenge: string;
  }): string {
    return `https://patreon.test/oauth2/authorize?state=${state}&code_challenge=${codeChallenge}`;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<PatreonTokens> {
    this.exchangeCalls.push({ code, codeVerifier });
    if (this.exchangeShouldFail) throw new Error('Patreon token exchange failed');
    return { accessToken: 'access-token', refreshToken: 'refresh-token', expiresInSeconds: 3600 };
  }

  async refreshTokens(refreshToken: string): Promise<PatreonTokens> {
    this.refreshCalls.push(refreshToken);
    if (this.refreshShouldFail) throw new Error('Patreon token refresh failed');
    return {
      accessToken: 'refreshed-access-token',
      refreshToken: 'refreshed-refresh-token',
      expiresInSeconds: 3600,
    };
  }

  async fetchIdentity(): Promise<PatreonIdentity> {
    if (this.identityShouldFail) throw new Error('Patreon identity fetch failed');
    return this.identity;
  }

  async fetchProfile(): Promise<PatreonProfile> {
    if (this.profileShouldFail) throw new Error('Patreon profile fetch failed');
    // Deliberately built field by field rather than spreading `identity`: spreading would carry
    // `memberships` through, and the whole point of the fallback type is that it cannot.
    return {
      patreonUserId: this.identity.patreonUserId,
      fullName: this.identity.fullName,
      email: this.identity.email,
      avatarUrl: this.identity.avatarUrl,
    };
  }

  async fetchOwnedCampaigns(): Promise<PatreonCampaign[]> {
    if (this.campaignsShouldFail) throw new Error('Patreon campaign lookup failed');
    return this.campaigns;
  }
}
