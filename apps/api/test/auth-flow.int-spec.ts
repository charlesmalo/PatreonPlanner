import request from 'supertest';
import { AuthTestContext, startAuthApp } from './support/auth-app';

describe('Patreon auth flow (integration)', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await startAuthApp();
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  async function startLogin(): Promise<string> {
    const res = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    return new URL(res.headers.location).searchParams.get('state') as string;
  }

  it('redirects to Patreon with state and a code challenge', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    expect(res.headers.location).toContain('state=');
    expect(res.headers.location).toContain('code_challenge=');
  });

  it('creates the user and a session cookie on a valid callback', async () => {
    const state = await startLogin();
    const res = await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .expect(302);

    const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
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
    const state = await startLogin();
    await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .expect(302);
    expect(ctx.patreon.exchangeCalls).toHaveLength(1);
    expect(ctx.patreon.exchangeCalls[0].codeVerifier).toMatch(/^[\w-]{40,}$/);
  });

  it('rejects a forged state', async () => {
    await request(ctx.app.getHttpServer())
      .get('/auth/patreon/callback?code=auth-code&state=forged')
      .expect(401);
  });

  it('rejects a replayed state', async () => {
    const state = await startLogin();
    await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .expect(302);
    await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .expect(401);
  });

  it('rejects a callback with no code', async () => {
    const state = await startLogin();
    await request(ctx.app.getHttpServer()).get(`/auth/patreon/callback?state=${state}`).expect(401);
  });

  it('stores patreon tokens encrypted, never in plaintext', async () => {
    const state = await startLogin();
    await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .expect(302);
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
      const state = await startLogin();
      const res = await request(ctx.app.getHttpServer())
        .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
        .expect(302);
      cookies.push((res.headers['set-cookie'] as unknown as string[])[0]);
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

    const state = await startLogin();
    await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .expect(302);

    const patron = await ctx.prisma.user.findUnique({ where: { patreonUserId: 'patron-1' } });
    const memberships = await ctx.prisma.membership.findMany({
      where: { userId: patron?.id },
      include: { currentTier: true },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].creatorId).toBe(creator.id);
    expect(memberships[0].isActivePatron).toBe(true);
    expect(memberships[0].currentTier?.patreonTierId).toBe('tier-a');
  });
});
