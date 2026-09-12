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
  /**
   * `refreshTokens` and `fetchProfile` were **wholly uncovered** — every line of both, found by
   * the per-file coverage floor rather than by anything failing. Every running system uses
   * `FakePatreonClient`, so the real client is exercised only against Patreon itself.
   *
   * `fetchProfile` is the one that matters: it is the sign-in path, and it exists specifically to
   * drop the `include` that makes the identity call time out for readers with many memberships.
   */
  it('renews a session from a refresh token', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'a2', refresh_token: 'r2', expires_in: 2678400 }),
    } as unknown as Response);
    global.fetch = fetchMock;

    const tokens = await client.refreshTokens('the-refresh-token');

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('the-refresh-token');
    expect(tokens).toEqual({ accessToken: 'a2', refreshToken: 'r2', expiresInSeconds: 2678400 });
  });

  it('throws without leaking the response body when a refresh is rejected', async () => {
    // The body of a token response can echo the refresh token back; only the status is logged.
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400 } as unknown as Response);

    await expect(client.refreshTokens('stale')).rejects.toThrow('Patreon token refresh failed');
  });

  it('asks for the profile without the include that makes identity time out', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          id: 'user-9',
          attributes: { full_name: 'Ada', email: 'ada@example.com', image_url: 'https://img' },
        },
      }),
    } as unknown as Response);
    global.fetch = fetchMock;

    const profile = await client.fetchProfile('token');

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('include')).toBeNull();
    expect(profile).toEqual({
      patreonUserId: 'user-9',
      fullName: 'Ada',
      email: 'ada@example.com',
      avatarUrl: 'https://img',
    });
  });

  it('reads a profile with no attributes at all as nulls, not undefined', async () => {
    // A `PatreonProfile` field is `string | null`; `undefined` would be written straight to a
    // column typed otherwise.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: 'user-9' } }),
    } as unknown as Response);

    const profile = await client.fetchProfile('token');

    expect(profile).toEqual({
      patreonUserId: 'user-9',
      fullName: null,
      email: null,
      avatarUrl: null,
    });
  });

  it('throws when the profile fetch is rejected', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 } as unknown as Response);

    await expect(client.fetchProfile('token')).rejects.toThrow('Patreon profile fetch failed');
  });

  it('throws when the identity fetch is rejected', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 } as unknown as Response);

    await expect(client.fetchIdentity('token')).rejects.toThrow('Patreon identity fetch failed');
  });

  it('reads an identity with no attributes as nulls', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: 'user-9' } }),
    } as unknown as Response);

    const identity = await client.fetchIdentity('token');

    expect(identity).toEqual({
      patreonUserId: 'user-9',
      fullName: null,
      email: null,
      avatarUrl: null,
      memberships: [],
    });
  });

  it('drops a membership that names no campaign rather than storing an empty id', async () => {
    const payload = {
      data: { id: 'user-9', relationships: { memberships: { data: [{ id: 'm1' }] } } },
      included: [{ id: 'm1', type: 'member', attributes: { patron_status: 'active_patron' } }],
    };
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => payload } as unknown as Response);

    const identity = await client.fetchIdentity('token');

    expect(identity.memberships).toEqual([]);
  });
});
