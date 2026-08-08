import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Patreon auth flow (integration)', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await startAuthApp();
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  /** Returns the state plus the cookie that binds the flow to this "browser". */
  async function startLogin(): Promise<{ state: string; cookie: string }> {
    const res = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    return {
      state: new URL(res.headers.location).searchParams.get('state') as string,
      cookie: pickCookie(res, 'pp_oauth_state'),
    };
  }

  function callback(state: string, cookie: string | null, code = 'auth-code') {
    const req = request(ctx.app.getHttpServer()).get(
      `/auth/patreon/callback?code=${code}&state=${state}`,
    );
    return cookie ? req.set('Cookie', cookie) : req;
  }

  it('redirects to Patreon with state and a code challenge', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    expect(res.headers.location).toContain('state=');
    expect(res.headers.location).toContain('code_challenge=');
  });

  it('creates the user and a session cookie on a valid callback', async () => {
    const { state, cookie: stateCookie } = await startLogin();
    const res = await callback(state, stateCookie).expect(302);

    const cookie = pickCookie(res, 'pp_session');
    expect(cookie).toContain('pp_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toMatch(/SameSite=Lax/i);

    const user = await ctx.prisma.user.findUnique({
      where: { patreonUserId: 'patreon-user-1' },
    });
    expect(user?.fullName).toBe('Ada Lovelace');
  });

  it('passes a PKCE verifier to the exchange', async () => {
    ctx.patreon.exchangeCalls = [];
    const { state, cookie: stateCookie } = await startLogin();
    await callback(state, stateCookie).expect(302);
    expect(ctx.patreon.exchangeCalls).toHaveLength(1);
    expect(ctx.patreon.exchangeCalls[0].codeVerifier).toMatch(/^[\w-]{40,}$/);
  });

  it('rejects a forged state', async () => {
    const { cookie: stateCookie } = await startLogin();
    await callback('forged', stateCookie).expect(401);
  });

  // Login CSRF: an attacker completes consent with their own Patreon account, keeps the
  // resulting code and state, and induces the victim to load the callback. Without binding the
  // flow to the browser that started it, the victim is handed a session belonging to the
  // attacker — every action they then take happens under the attacker's identity.
  it('rejects a callback redeemed from a browser that did not start the flow', async () => {
    const { state } = await startLogin();
    await callback(state, null).expect(401);
  });

  it('rejects a callback whose state cookie belongs to a different flow', async () => {
    const first = await startLogin();
    const second = await startLogin();
    await callback(first.state, second.cookie).expect(401);
  });

  it('clears the state cookie once the flow completes', async () => {
    const { state, cookie: stateCookie } = await startLogin();
    const res = await callback(state, stateCookie).expect(302);
    // Left in place, it would be replayable against a future state.
    expect(pickCookie(res, 'pp_oauth_state')).toMatch(/pp_oauth_state=;/);
  });

  it('rejects a replayed state', async () => {
    const { state, cookie: stateCookie } = await startLogin();
    await callback(state, stateCookie).expect(302);
    await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .expect(401);
  });

  // 400, not 401: a missing parameter is a malformed request, rejected by the DTO before the
  // handler runs. It reveals nothing about whether any state exists.
  it('rejects a callback with no code', async () => {
    const { state, cookie: stateCookie } = await startLogin();
    await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?state=${state}`)
      .set('Cookie', stateCookie)
      .expect(400);
  });

  it('rejects a callback whose code arrives as an array', async () => {
    const { state, cookie: stateCookie } = await startLogin();
    await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=a&code=b&state=${state}`)
      .set('Cookie', stateCookie)
      .expect(400);
  });

  it('stores patreon tokens encrypted, never in plaintext', async () => {
    const { state, cookie: stateCookie } = await startLogin();
    await callback(state, stateCookie).expect(302);
    const user = await ctx.prisma.user.findUnique({
      where: { patreonUserId: 'patreon-user-1' },
    });
    expect(user?.accessTokenEncrypted).not.toBe('access-token');
    expect(user?.refreshTokenEncrypted).not.toBe('refresh-token');
    expect(user?.accessTokenEncrypted).toContain('v1:');
    expect(user?.tokenExpiresAt).toBeInstanceOf(Date);
  });

  it('issues a different session token on each login', async () => {
    const cookies: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const { state, cookie: stateCookie } = await startLogin();
      const res = await callback(state, stateCookie).expect(302);
      cookies.push(pickCookie(res, 'pp_session'));
    }
    // Rotation on login: a token captured before login is never the authenticated one.
    expect(cookies[0]).not.toBe(cookies[1]);
  });

  it('syncs a membership only for a campaign already claimed as a creator', async () => {
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'owner-1' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'campaign-known',
        ownerUserId: owner.id,
        displayName: 'Known Creator',
        slug: 'known-creator',
      },
    });
    await ctx.prisma.tier.create({
      data: {
        creatorId: creator.id,
        patreonTierId: 'tier-a',
        title: 'Supporter',
        amountCents: 500,
        order: 1,
      },
    });

    ctx.patreon.identity = {
      ...ctx.patreon.identity,
      patreonUserId: 'patron-1',
      memberships: [
        {
          campaignId: 'campaign-known',
          patreonTierIds: ['tier-a'],
          amountCents: 500,
          isActivePatron: true,
        },
        // Not claimed by anyone — must be skipped rather than half-created.
        {
          campaignId: 'campaign-unknown',
          patreonTierIds: [],
          amountCents: 300,
          isActivePatron: true,
        },
      ],
    };

    const { state, cookie: stateCookie } = await startLogin();
    await callback(state, stateCookie).expect(302);

    const patron = await ctx.prisma.user.findUnique({ where: { patreonUserId: 'patron-1' } });
    const memberships = await ctx.prisma.membership.findMany({
      where: { userId: patron?.id },
      include: { currentTier: true },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].creatorId).toBe(creator.id);
    expect(memberships[0].isActivePatron).toBe(true);
    expect(memberships[0].currentTier?.patreonTierId).toBe('tier-a');

    // A lapsed membership stops appearing in Patreon's payload rather than being reported as
    // inactive, so re-sync has to revoke as well as grant — otherwise Plan 03's guards would
    // keep honouring access that ended.
    ctx.patreon.identity = { ...ctx.patreon.identity, memberships: [] };
    const next = await startLogin();
    await callback(next.state, next.cookie).expect(302);

    const after = await ctx.prisma.membership.findFirst({ where: { userId: patron?.id } });
    expect(after?.isActivePatron).toBe(false);
    expect(after?.currentTierId).toBeNull();
  });
});
