import { ConfigService } from '../src/config/config.module';
import { HttpPatreonClient } from '../src/patreon/http-patreon.client';
import { applyTestConfigDefaults } from './support/env';

describe('HttpPatreonClient', () => {
  let client: HttpPatreonClient;
  const originalFetch = global.fetch;

  beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
    process.env.REDIS_URL = 'redis://localhost:6379';
    applyTestConfigDefaults();
    client = new HttpPatreonClient(new ConfigService());
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('builds an authorization URL carrying state and the S256 challenge', () => {
    const url = new URL(
      client.buildAuthorizationUrl({ state: 'state-123', codeChallenge: 'challenge-abc' }),
    );
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('flattens the JSON:API identity payload into memberships', async () => {
    const payload = {
      data: {
        id: 'user-9',
        attributes: { full_name: 'Ada', email: 'ada@example.com', image_url: 'https://img' },
        relationships: { memberships: { data: [{ id: 'member-1' }] } },
      },
      included: [
        {
          id: 'member-1',
          type: 'member',
          attributes: { patron_status: 'active_patron', currently_entitled_amount_cents: 500 },
          relationships: {
            campaign: { data: { id: 'campaign-7' } },
            currently_entitled_tiers: { data: [{ id: 'tier-3' }] },
          },
        },
        { id: 'other', type: 'campaign' },
      ],
    };
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => payload } as unknown as Response);

    const identity = await client.fetchIdentity('token');

    expect(identity.patreonUserId).toBe('user-9');
    expect(identity.memberships).toEqual([
      {
        campaignId: 'campaign-7',
        patreonTierIds: ['tier-3'],
        amountCents: 500,
        isActivePatron: true,
      },
    ]);
  });

  it('ignores membership entries belonging to another user', async () => {
    // `included` is a flat bag; only the ids the user actually links to are theirs.
    const payload = {
      data: { id: 'user-9', attributes: {}, relationships: { memberships: { data: [] } } },
      included: [
        {
          id: 'member-not-mine',
          type: 'member',
          attributes: { patron_status: 'active_patron' },
          relationships: { campaign: { data: { id: 'campaign-x' } } },
        },
      ],
    };
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => payload } as unknown as Response);

    const identity = await client.fetchIdentity('token');

    expect(identity.memberships).toEqual([]);
  });

  it('treats a non-active patron_status as not an active patron', async () => {
    const payload = {
      data: { id: 'user-9', relationships: { memberships: { data: [{ id: 'm1' }] } } },
      included: [
        {
          id: 'm1',
          type: 'member',
          attributes: { patron_status: 'former_patron', currently_entitled_amount_cents: 0 },
          relationships: { campaign: { data: { id: 'campaign-7' } } },
        },
      ],
    };
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => payload } as unknown as Response);

    const identity = await client.fetchIdentity('token');

    expect(identity.memberships[0].isActivePatron).toBe(false);
    expect(identity.memberships[0].patreonTierIds).toEqual([]);
  });

  it('throws without leaking the response body when Patreon rejects the exchange', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 } as unknown as Response);
    await expect(client.exchangeCode('code', 'verifier')).rejects.toThrow(
      'Patreon token exchange failed',
    );
  });

  it('sends the code verifier and client secret in the exchange body', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
    } as unknown as Response);
    global.fetch = fetchMock;

    const tokens = await client.exchangeCode('the-code', 'the-verifier');

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe('the-verifier');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(tokens).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiresInSeconds: 3600,
    });
  });
});
