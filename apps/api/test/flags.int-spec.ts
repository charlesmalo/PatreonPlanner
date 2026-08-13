import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Community flags (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let otherCreatorId: string;
  let patron: Auth;
  let otherPatron: Auth;
  let patronUserId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'fl-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'fl-campaign',
        ownerUserId: owner.id,
        displayName: 'Flag Co',
        slug: 'flag-co',
        policy: { create: {} },
      },
    });
    creatorId = creator.id;
    const other = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'fl-other-campaign',
        ownerUserId: owner.id,
        displayName: 'Other Flag Co',
        slug: 'fl-other',
        policy: { create: {} },
      },
    });
    otherCreatorId = other.id;

    patron = await loginAs('fl-patron');
    patronUserId = (
      await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'fl-patron' } })
    ).id;
    otherPatron = await loginAs('fl-other-patron');
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    // This suite trips the pipeline on purpose; strikes would otherwise time the patron out.
    await ctx.prisma.abuseRecord.deleteMany();
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

  type Auth = Awaited<ReturnType<typeof loginAs>>;

  let counter = 0;
  async function makeEntry(targetCreatorId = creatorId) {
    counter += 1;
    return ctx.prisma.recommendation.create({
      data: {
        creatorId: targetCreatorId,
        submittedByUserId: patronUserId,
        type: 'EXTERNAL_LINK',
        customTitle: `Flaggable ${counter}`,
        normalizedTitle: `flaggable ${counter}`,
      },
    });
  }

  const flag = (auth: Auth, id: string, body: object, slug = 'flag-co') =>
    request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/${slug}/recommendations/${id}/flags`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  it('lets any viewer flag an entry', async () => {
    // VIEW, not SUBMIT: gating reports behind a pledge tier means the cheapest accounts see the
    // worst content with no recourse.
    const rec = await makeEntry();
    const res = await flag(patron, rec.id, { reason: 'SPAM', note: 'link farm' }).expect(201);
    expect(res.body).toMatchObject({ status: 'OPEN', duplicate: false });
  });

  it('returns the existing flag rather than erroring on a repeat', async () => {
    const rec = await makeEntry();
    await flag(patron, rec.id, { reason: 'SPAM' }).expect(201);
    const res = await flag(patron, rec.id, { reason: 'HARASSMENT' }).expect(200);
    expect(res.body.duplicate).toBe(true);
    expect(await ctx.prisma.flag.count({ where: { recommendationId: rec.id } })).toBe(1);
  });

  it('counts flags from different users separately', async () => {
    const rec = await makeEntry();
    await flag(patron, rec.id, { reason: 'SPAM' }).expect(201);
    await flag(otherPatron, rec.id, { reason: 'OFF_TOPIC' }).expect(201);
    expect(await ctx.prisma.flag.count({ where: { recommendationId: rec.id } })).toBe(2);
  });

  it('refuses an anonymous flag', async () => {
    const rec = await makeEntry();
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/flag-co/recommendations/${rec.id}/flags`)
      .send({ reason: 'SPAM' })
      .expect(403); // CSRF first
  });

  it('refuses a flag on another creator entry', async () => {
    const foreign = await makeEntry(otherCreatorId);
    await flag(patron, foreign.id, { reason: 'SPAM' }).expect(404);
  });

  it('rejects an unknown reason', async () => {
    const rec = await makeEntry();
    await flag(patron, rec.id, { reason: 'VIBES' }).expect(400);
  });

  it('strikes the reporter when their note is blocked', async () => {
    // Design §6.5: a BLOCK is a strike wherever the pipeline runs. Flag notes were a free
    // oracle — binary-search the blocklist here at no cost, then craft a submission that passes
    // the check that *does* cost you.
    const rec = await makeEntry();
    await flag(patron, rec.id, { reason: 'OTHER', note: 'this is shit' }).expect(400);
    const record = await ctx.prisma.abuseRecord.findUnique({ where: { userId: patronUserId } });
    expect(record?.strikeCount).toBe(1);
  });

  it('runs the note through moderation', async () => {
    // The note is attacker-chosen text shown to a moderator. Design §6.5 puts every user string
    // through the pipeline, and the review queue is not an exemption.
    const rec = await makeEntry();
    await flag(patron, rec.id, { reason: 'OTHER', note: 'this is shit' }).expect(400);
    expect(await ctx.prisma.flag.count({ where: { recommendationId: rec.id } })).toBe(0);
  });
});
