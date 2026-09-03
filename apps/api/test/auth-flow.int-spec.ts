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

  /**
   * Patreon's identity endpoint is reported to time out for readers with many memberships —
   * server-side, at around ten seconds, and not helped by paging or trimming fields. Since
   * `completeLogin` needed it to succeed, the people supporting the most creators could not sign
   * in at all rather than now and then.
   */
  describe('when Patreon cannot answer what they support', () => {
    const READER = 'fallback-reader';
    let restore: typeof ctx.patreon.identity;

    beforeEach(() => {
      // Its own reader, installed here rather than relying on whatever the previous test left
      // behind. An earlier test in this file rewrites `patreonUserId` to 'patron-1' and never
      // puts it back, so these passed alone and failed in sequence — reading a user the login
      // was no longer touching.
      restore = ctx.patreon.identity;
      ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId: READER, memberships: [] };
    });

    afterEach(() => {
      ctx.patreon.identity = restore;
      ctx.patreon.identityShouldFail = false;
      ctx.patreon.profileShouldFail = false;
    });

    it('still signs them in', async () => {
      ctx.patreon.identityShouldFail = true;
      const { state, cookie } = await startLogin();

      const res = await callback(state, cookie).expect(302);

      expect(pickCookie(res, 'pp_session')).toContain('pp_session=');
    });

    it('still records who they are', async () => {
      ctx.patreon.identityShouldFail = true;
      const { state, cookie } = await startLogin();

      await callback(state, cookie).expect(302);

      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { patreonUserId: READER },
      });
      expect(user.fullName).toBe('Ada Lovelace');
    });

    it('leaves the memberships they already had exactly alone', async () => {
      // The reason the fallback returns a type with no memberships field. Treating "we did not
      // ask" as "they support nobody" would revoke every board they pay for, silently, at the
      // moment they signed in.
      const { state: s1, cookie: c1 } = await startLogin();
      await callback(s1, c1).expect(302);
      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { patreonUserId: READER },
      });
      const suffix = Date.now();
      const owner = await ctx.prisma.user.create({
        data: { patreonUserId: `fallback-owner-${suffix}` },
      });
      const creator = await ctx.prisma.creator.create({
        data: {
          slug: `fallback-${suffix}`,
          displayName: 'Fallback Board',
          patreonCampaignId: `campaign-fallback-${suffix}`,
          ownerUserId: owner.id,
        },
      });
      await ctx.prisma.membership.create({
        data: {
          userId: user.id,
          creatorId: creator.id,
          amountCents: 500,
          isActivePatron: true,
          lastSyncedAt: new Date(),
        },
      });

      ctx.patreon.identityShouldFail = true;
      const { state: s2, cookie: c2 } = await startLogin();
      await callback(s2, c2).expect(302);

      const membership = await ctx.prisma.membership.findFirstOrThrow({
        where: { userId: user.id, creatorId: creator.id },
      });
      expect(membership.isActivePatron).toBe(true);
      expect(membership.amountCents).toBe(500);
    });

    /**
     * Stamped first, deliberately. Nothing on the ordinary login path sets this — only the
     * background job does — so on a fresh user it is null either way, and asserting null after a
     * failed login would pass whether or not the code did anything at all.
     */
    const stampRefreshedAt = async () => {
      const { state, cookie } = await startLogin();
      await callback(state, cookie).expect(302);
      return ctx.prisma.user.update({
        where: { patreonUserId: READER },
        data: { membershipsRefreshedAt: new Date('2026-01-01T00:00:00Z') },
      });
    };

    it('puts them at the front of the refresh queue', async () => {
      // Nothing was learned about what they support, so the background job has to go and find
      // out. It orders by this stamp with nulls first.
      await stampRefreshedAt();

      ctx.patreon.identityShouldFail = true;
      const { state, cookie } = await startLogin();
      await callback(state, cookie).expect(302);

      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { patreonUserId: READER },
      });
      expect(user.membershipsRefreshedAt).toBeNull();
    });

    it('refuses the login when it cannot identify them either', async () => {
      // The fallback is about degrading, not about guessing. With no id there is no reader to
      // sign in, and inventing one would be worse than refusing.
      ctx.patreon.identityShouldFail = true;
      ctx.patreon.profileShouldFail = true;
      const { state, cookie } = await startLogin();

      await callback(state, cookie).expect(500);
    });

    it('leaves the refresh stamp alone when the full fetch works', async () => {
      // The ordinary path must be untouched. Clearing the stamp here would claim nothing had
      // been learned, and send the job chasing a reader whose memberships were just applied.
      const stamped = await stampRefreshedAt();

      const { state, cookie } = await startLogin();
      await callback(state, cookie).expect(302);

      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { patreonUserId: READER },
      });
      expect(user.membershipsRefreshedAt).toEqual(stamped.membershipsRefreshedAt);
    });
  });
});
