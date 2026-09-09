import { createHmac } from 'node:crypto';
import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

/**
 * Listing the campaigns a caller could claim, and claiming one.
 *
 * `POST /creators/claim` has existed since the beginning and nothing could reach it: it takes a
 * `patreonCampaignId` and there was no way to learn one. Every board in this project was created
 * by SQL or by a test, and in production the product had no front door for creators at all.
 *
 * The listing endpoint is what makes the existing one usable. It exposes nothing new — `claim`
 * already fetched the same campaigns to check ownership and threw them away.
 */
describe('Claiming a board (integration)', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await startAuthApp();
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(() => {
    ctx.patreon.campaignsShouldFail = false;
    ctx.patreon.campaigns = [];
  });

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

  const campaign = (id: string, name: string) => ({
    campaignId: id,
    displayName: name,
    tiers: [{ patreonTierId: `${id}-t1`, title: 'Supporter', amountCents: 500, order: 0 }],
  });

  it('lists the campaigns this account owns', async () => {
    const auth = await loginAs('claim-lister');
    ctx.patreon.campaigns = [campaign('camp-a', 'Ada Writes'), campaign('camp-b', 'Ada Draws')];

    const res = await request(ctx.app.getHttpServer())
      .get('/api/v1/creators/claimable')
      .set('Cookie', auth.session)
      .expect(200);

    expect(res.body.items).toEqual([
      { patreonCampaignId: 'camp-a', displayName: 'Ada Writes', claimed: false, slug: null },
      { patreonCampaignId: 'camp-b', displayName: 'Ada Draws', claimed: false, slug: null },
    ]);
  });

  it('marks one that is already a board, and says where it went', async () => {
    // Otherwise the only way to discover it is to press claim and read a 409. A creator who
    // claimed a campaign last week should be sent to it, not told they cannot have it.
    const auth = await loginAs('claim-repeat');
    ctx.patreon.campaigns = [campaign('camp-taken', 'Already Mine')];
    await request(ctx.app.getHttpServer())
      .post('/api/v1/creators/claim')
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ patreonCampaignId: 'camp-taken' })
      .expect(201);

    const res = await request(ctx.app.getHttpServer())
      .get('/api/v1/creators/claimable')
      .set('Cookie', auth.session)
      .expect(200);

    expect(res.body.items).toEqual([
      {
        patreonCampaignId: 'camp-taken',
        displayName: 'Already Mine',
        claimed: true,
        slug: 'already-mine',
      },
    ]);
  });

  it('refuses a caller with no session', async () => {
    await request(ctx.app.getHttpServer()).get('/api/v1/creators/claimable').expect(401);
  });

  it('reports an upstream failure as an upstream failure', async () => {
    // Not an empty list. "You own no campaigns" is a different statement from "Patreon could not
    // be reached", and telling a creator the first when the second is true sends them away.
    const auth = await loginAs('claim-outage');
    ctx.patreon.campaignsShouldFail = true;

    await request(ctx.app.getHttpServer())
      .get('/api/v1/creators/claimable')
      .set('Cookie', auth.session)
      .expect(502);
  });

  it('creates the board, its policy and its owner staff row', async () => {
    const auth = await loginAs('claim-creator');
    ctx.patreon.campaigns = [campaign('camp-new', 'Brand New Board')];

    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/creators/claim')
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ patreonCampaignId: 'camp-new' })
      .expect(201);

    const created = await ctx.prisma.creator.findUniqueOrThrow({
      where: { id: res.body.id },
      include: { policy: true, staff: true, tiers: true },
    });
    expect(created.policy).not.toBeNull();
    expect(created.staff).toHaveLength(1);
    expect(created.staff[0].role).toBe('OWNER');
    expect(created.tiers).toHaveLength(1);
    // The default the DMCA-scraping reasoning settled on. A board must not be born public.
    expect(created.policy?.viewVisibility).toBe('SUBSCRIBERS_ONLY');
  });

  it('refuses a campaign this account does not own', async () => {
    const auth = await loginAs('claim-thief');
    ctx.patreon.campaigns = [campaign('camp-mine', 'Mine')];

    await request(ctx.app.getHttpServer())
      .post('/api/v1/creators/claim')
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ patreonCampaignId: 'camp-someone-elses' })
      .expect(403);
  });
});

/**
 * Whether a board's webhook secret is set — never what it is.
 *
 * `PUT webhook-secret` has existed since Phase 1 and nothing called it, so per-creator Patreon
 * webhooks were dead in production: without a secret the signature guard rejects every delivery.
 * A page to set one needs to know whether one is already there, and there was no way to ask.
 */
describe('Webhook secret state (integration)', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await startAuthApp();
  });

  afterAll(async () => {
    await ctx.teardown();
  });

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

  async function boardOwnedBy(patreonUserId: string, campaignId: string) {
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: campaignId,
        ownerUserId: user.id,
        displayName: 'Hook Board',
        slug: `hook-${campaignId}`,
        policy: { create: {} },
        staff: { create: { userId: user.id, role: 'OWNER' } },
      },
      select: { id: true },
    });
    return creator.id;
  }

  it('says a board has no secret before one is set', async () => {
    const auth = await loginAs('hook-owner-a');
    const creatorId = await boardOwnedBy('hook-owner-a', 'hook-campaign-a');

    const res = await request(ctx.app.getHttpServer())
      .get(`/api/v1/creators/${creatorId}/webhook-secret`)
      .set('Cookie', auth.session)
      .expect(200);

    expect(res.body).toEqual({ configured: false });
  });

  it('says it has one afterwards, and never returns the secret itself', async () => {
    const auth = await loginAs('hook-owner-b');
    const creatorId = await boardOwnedBy('hook-owner-b', 'hook-campaign-b');

    await request(ctx.app.getHttpServer())
      .put(`/api/v1/creators/${creatorId}/webhook-secret`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ secret: 'a-real-looking-secret' })
      .expect(200);

    const res = await request(ctx.app.getHttpServer())
      .get(`/api/v1/creators/${creatorId}/webhook-secret`)
      .set('Cookie', auth.session)
      .expect(200);

    expect(res.body).toEqual({ configured: true });
    // The whole body, so a secret added to the payload later fails here rather than leaking.
    expect(JSON.stringify(res.body)).not.toContain('a-real-looking-secret');
  });

  it('is stored encrypted rather than as typed', async () => {
    const auth = await loginAs('hook-owner-c');
    const creatorId = await boardOwnedBy('hook-owner-c', 'hook-campaign-c');

    await request(ctx.app.getHttpServer())
      .put(`/api/v1/creators/${creatorId}/webhook-secret`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ secret: 'plain-text-secret' })
      .expect(200);

    const row = await ctx.prisma.creator.findUniqueOrThrow({
      where: { id: creatorId },
      select: { webhookSecretEncrypted: true },
    });
    expect(row.webhookSecretEncrypted).not.toContain('plain-text-secret');
  });

  it('a secret registered through the endpoint makes a real delivery succeed', async () => {
    // The reason the page exists. Everything else here checks a boolean; this checks that setting
    // the secret is what turns Patreon's deliveries from rejected into accepted — which is the
    // only claim the settings page actually makes.
    const auth = await loginAs('hook-owner-e');
    const creatorId = await boardOwnedBy('hook-owner-e', 'hook-campaign-e');
    const secret = 'secret-from-the-portal';
    const body = JSON.stringify({ data: { attributes: {}, relationships: {} } });
    const deliver = () =>
      request(ctx.app.getHttpServer())
        // Root path: webhooks are excluded from the global prefix, because the URL is registered
        // with Patreon and must not move when the API version does.
        .post(`/webhooks/patreon/${creatorId}`)
        .set('X-Patreon-Event', 'members:pledge:delete')
        .set(
          'X-Patreon-Signature',
          createHmac('md5', secret).update(Buffer.from(body)).digest('hex'),
        )
        .set('Content-Type', 'application/json')
        .send(body);

    // Before: correctly signed for a secret the board does not have, so it is rejected — this is
    // the state every board was in, because nothing could set one.
    await deliver().expect(401);

    await request(ctx.app.getHttpServer())
      .put(`/api/v1/creators/${creatorId}/webhook-secret`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ secret })
      .expect(200);

    // After: the same delivery, now accepted. 204 rather than 200 — the webhook returns no body.
    await deliver().expect(204);
  });

  it('refuses a moderator who is not the owner', async () => {
    // ADMINISTER, not MODERATE: whoever holds this secret can forge membership events, minting
    // active-patron status at any pledge for anyone on the campaign.
    const ownerAuth = await loginAs('hook-owner-d');
    const creatorId = await boardOwnedBy('hook-owner-d', 'hook-campaign-d');
    const modAuth = await loginAs('hook-mod');
    const mod = await ctx.prisma.user.findUniqueOrThrow({
      where: { patreonUserId: 'hook-mod' },
    });
    await ctx.prisma.creatorStaff.create({
      data: { creatorId, userId: mod.id, role: 'MOD', permissions: ['MANAGE_POLICY'] },
    });

    await request(ctx.app.getHttpServer())
      .get(`/api/v1/creators/${creatorId}/webhook-secret`)
      .set('Cookie', modAuth.session)
      .expect(403);
    expect(ownerAuth.session).toBeDefined();
  });
});
