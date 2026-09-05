import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('POST /api/v1/creators/claim (integration)', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await startAuthApp();
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  /** Logs in and returns the cookies plus CSRF token a state-changing request needs. */
  async function loginAs(patreonUserId: string) {
    ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId, memberships: [] };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    const res = await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    const csrf = pickCookie(res, 'pp_csrf').split(';')[0];
    return {
      session: pickCookie(res, 'pp_session'),
      csrf,
      csrfToken: csrf.split('=').slice(1).join('='),
    };
  }

  function claim(auth: Awaited<ReturnType<typeof loginAs>>, body: object) {
    return request(ctx.app.getHttpServer())
      .post('/api/v1/creators/claim')
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);
  }

  const campaign = {
    campaignId: 'campaign-owned',
    displayName: 'Ada Writes',
    tiers: [
      { patreonTierId: 'tier-lo', title: 'Bronze', amountCents: 300, order: 0 },
      { patreonTierId: 'tier-hi', title: 'Gold', amountCents: 1000, order: 1 },
    ],
  };

  it('rejects an unauthenticated claim', async () => {
    // CSRF rejects before authentication is even considered.
    await request(ctx.app.getHttpServer())
      .post('/api/v1/creators/claim')
      .send({ patreonCampaignId: 'campaign-owned' })
      .expect(403);
  });

  it('rejects a campaign the user does not own', async () => {
    const auth = await loginAs('claimer-1');
    ctx.patreon.campaigns = [];
    await claim(auth, { patreonCampaignId: 'campaign-owned' }).expect(403);
  });

  it('creates the creator, tiers, owner staff row and default policy', async () => {
    const auth = await loginAs('claimer-2');
    ctx.patreon.campaigns = [campaign];

    const res = await claim(auth, {
      patreonCampaignId: 'campaign-owned',
      baseUrl: 'https://ada.example.com',
    }).expect(201);

    expect(res.body).toEqual({
      id: expect.any(String),
      slug: 'ada-writes',
      displayName: 'Ada Writes',
    });

    const creator = await ctx.prisma.creator.findUniqueOrThrow({
      where: { patreonCampaignId: 'campaign-owned' },
      include: { tiers: true, staff: true, policy: true },
    });
    expect(creator.baseUrl).toBe('https://ada.example.com');
    expect(creator.tiers.map((t) => t.patreonTierId).sort()).toEqual(['tier-hi', 'tier-lo']);
    expect(creator.staff).toHaveLength(1);
    expect(creator.staff[0].role).toBe('OWNER');
    expect(creator.policy?.viewVisibility).toBe('SUBSCRIBERS_ONLY');
  });

  it('refuses to claim a campaign someone else already claimed', async () => {
    const first = await loginAs('claimer-3');
    ctx.patreon.campaigns = [{ ...campaign, campaignId: 'campaign-contested' }];
    await claim(first, { patreonCampaignId: 'campaign-contested' }).expect(201);

    const second = await loginAs('claimer-4');
    ctx.patreon.campaigns = [{ ...campaign, campaignId: 'campaign-contested' }];
    await claim(second, { patreonCampaignId: 'campaign-contested' }).expect(409);
  });

  it('gives a second creator with the same name a distinct slug', async () => {
    const auth = await loginAs('claimer-5');
    ctx.patreon.campaigns = [{ ...campaign, campaignId: 'campaign-dup' }];
    const res = await claim(auth, { patreonCampaignId: 'campaign-dup' }).expect(201);
    expect(res.body.slug).not.toBe('ada-writes');
    expect(res.body.slug).toMatch(/^ada-writes-/);
  });

  it('rejects a malformed body', async () => {
    const auth = await loginAs('claimer-6');
    await claim(auth, { patreonCampaignId: '' }).expect(400);
    await claim(auth, { patreonCampaignId: 'x', unexpected: 'field' }).expect(400);
    await claim(auth, { patreonCampaignId: 'x', baseUrl: 'javascript:alert(1)' }).expect(400);
  });

  it('reports a Patreon outage without a 500', async () => {
    const auth = await loginAs('claimer-7');
    ctx.patreon.campaignsShouldFail = true;
    // 502, not 403: an upstream failure is not the caller's fault and must not read as
    // "you do not own this".
    await claim(auth, { patreonCampaignId: 'campaign-owned' }).expect(502);
    ctx.patreon.campaignsShouldFail = false;
  });

  it('leaves nothing behind when the claim fails', async () => {
    const auth = await loginAs('claimer-8');
    ctx.patreon.campaigns = [];
    await claim(auth, { patreonCampaignId: 'campaign-ghost' }).expect(403);
    expect(await ctx.prisma.creator.count({ where: { patreonCampaignId: 'campaign-ghost' } })).toBe(
      0,
    );
  });

  it('imports every tier of the claimed campaign', async () => {
    const auth = await loginAs('claimer-9');
    ctx.patreon.campaigns = [{ ...campaign, campaignId: 'campaign-tiers' }];
    const res = await claim(auth, { patreonCampaignId: 'campaign-tiers' }).expect(201);
    const tiers = await ctx.prisma.tier.findMany({
      where: { creatorId: res.body.id },
      orderBy: { amountCents: 'asc' },
    });
    expect(tiers.map((t) => [t.title, t.amountCents, t.order])).toEqual([
      ['Bronze', 300, 0],
      ['Gold', 1000, 1],
    ]);
  });
});
