import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.module';
import { PatreonClient } from './patreon.client';
import { PatreonIdentity, PatreonMembership, PatreonTokens } from './patreon.types';

const AUTHORIZE_URL = 'https://www.patreon.com/oauth2/authorize';
const TOKEN_URL = 'https://www.patreon.com/api/oauth2/token';
const IDENTITY_URL = 'https://www.patreon.com/api/oauth2/v2/identity';

interface IdentityPayload {
  data: {
    id: string;
    attributes?: { full_name?: string; email?: string; image_url?: string };
    relationships?: { memberships?: { data?: Array<{ id: string }> } };
  };
  included?: Array<{
    id: string;
    type: string;
    attributes?: { patron_status?: string; currently_entitled_amount_cents?: number };
    relationships?: {
      campaign?: { data?: { id: string } };
      currently_entitled_tiers?: { data?: Array<{ id: string }> };
    };
  }>;
}

@Injectable()
export class HttpPatreonClient implements PatreonClient {
  private readonly logger = new Logger(HttpPatreonClient.name);

  constructor(private readonly config: ConfigService) {}

  buildAuthorizationUrl({
    state,
    codeChallenge,
  }: {
    state: string;
    codeChallenge: string;
  }): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.get('PATREON_CLIENT_ID'),
      redirect_uri: this.config.get('PATREON_REDIRECT_URI'),
      // `campaigns` is what makes claiming possible: Patreon returns only campaigns this
      // token's owner controls, which is the ownership proof. Adding it changes the consent
      // screen, so sessions predating this must log in again before a claim can succeed.
      scope: 'identity identity[email] identity.memberships campaigns',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<PatreonTokens> {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: this.config.get('PATREON_CLIENT_ID'),
        client_secret: this.config.get('PATREON_CLIENT_SECRET'),
        redirect_uri: this.config.get('PATREON_REDIRECT_URI'),
        code_verifier: codeVerifier,
      }).toString(),
    });
    if (!response.ok) {
      // The body can echo back the code or the client secret, so log the status only.
      this.logger.warn(`Patreon token exchange failed with status ${response.status}`);
      throw new Error('Patreon token exchange failed');
    }
    const body = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresInSeconds: body.expires_in,
    };
  }

  async refreshTokens(refreshToken: string): Promise<PatreonTokens> {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.config.get('PATREON_CLIENT_ID'),
        client_secret: this.config.get('PATREON_CLIENT_SECRET'),
      }).toString(),
    });
    if (!response.ok) {
      this.logger.warn(`Patreon token refresh failed with status ${response.status}`);
      throw new Error('Patreon token refresh failed');
    }
    const body = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresInSeconds: body.expires_in,
    };
  }

  async fetchIdentity(accessToken: string): Promise<PatreonIdentity> {
    const params = new URLSearchParams({
      include: 'memberships,memberships.campaign,memberships.currently_entitled_tiers',
      'fields[user]': 'full_name,email,image_url',
      'fields[member]': 'patron_status,currently_entitled_amount_cents',
    });
    const response = await fetch(`${IDENTITY_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      this.logger.warn(`Patreon identity fetch failed with status ${response.status}`);
      throw new Error('Patreon identity fetch failed');
    }
    return this.parseIdentity((await response.json()) as IdentityPayload);
  }

  /**
   * Patreon speaks JSON:API: memberships arrive in a flat `included` bag shared by every
   * relationship, cross-linked by id. Flatten it here so nothing downstream has to know that
   * shape — and filter by the ids the user actually links to, since `included` also carries
   * entries belonging to other relationships.
   */
  private parseIdentity(body: IdentityPayload): PatreonIdentity {
    const memberIds = new Set((body.data.relationships?.memberships?.data ?? []).map((m) => m.id));
    const memberships: PatreonMembership[] = (body.included ?? [])
      .filter((entry) => entry.type === 'member' && memberIds.has(entry.id))
      .map((entry) => ({
        campaignId: entry.relationships?.campaign?.data?.id ?? '',
        patreonTierIds: (entry.relationships?.currently_entitled_tiers?.data ?? []).map(
          (tier) => tier.id,
        ),
        amountCents: entry.attributes?.currently_entitled_amount_cents ?? 0,
        isActivePatron: entry.attributes?.patron_status === 'active_patron',
      }))
      .filter((membership) => membership.campaignId !== '');

    return {
      patreonUserId: body.data.id,
      fullName: body.data.attributes?.full_name ?? null,
      email: body.data.attributes?.email ?? null,
      avatarUrl: body.data.attributes?.image_url ?? null,
      memberships,
    };
  }
}
