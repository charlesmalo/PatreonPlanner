import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Submission lifecycle (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let otherCreatorId: string;
  let staff: Auth;
  let patron: Auth;
  let staffUserId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'lc-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'lc-campaign',
        ownerUserId: owner.id,
        displayName: 'Lifecycle Co',
        slug: 'lifecycle-co',
        policy: { create: {} },
      },
    });
    creatorId = creator.id;

    const other = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'lc-other-campaign',
        ownerUserId: owner.id,
        displayName: 'Other Co',
        slug: 'lc-other',
        policy: { create: {} },
      },
    });
    otherCreatorId = other.id;

    staff = await loginAs('lc-staff');
    staffUserId = (
      await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'lc-staff' } })
    ).id;
    await ctx.prisma.creatorStaff.create({
      data: { creatorId, userId: staffUserId, role: 'MOD' },
    });

    patron = await loginAs('lc-patron');
    const patronUser = await ctx.prisma.user.findUniqueOrThrow({
      where: { patreonUserId: 'lc-patron' },
    });
    await ctx.prisma.membership.create({
      data: { userId: patronUser.id, creatorId, amountCents: 500, isActivePatron: true },
    });
  }, 240_000);

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

  type Auth = Awaited<ReturnType<typeof loginAs>>;

  let counter = 0;
  async function makeEntry(targetCreatorId = creatorId) {
    const submitter = await ctx.prisma.user.findUniqueOrThrow({
      where: { patreonUserId: 'lc-patron' },
    });
    counter += 1;
    return ctx.prisma.recommendation.create({
      data: {
        creatorId: targetCreatorId,
        submittedByUserId: submitter.id,
        type: 'EXTERNAL_LINK',
        customTitle: `Entry ${counter}`,
        normalizedTitle: `entry ${counter}`,
      },
    });
  }

  const changeStatus = (auth: Auth, id: string, body: object, slug = 'lifecycle-co') =>
    request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/${slug}/recommendations/${id}/status`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  it('moves a pending entry to accepted and audits it', async () => {
    const rec = await makeEntry();
    const res = await changeStatus(staff, rec.id, { status: 'ACCEPTED' }).expect(200);
    expect(res.body.status).toBe('ACCEPTED');

    const actions = await ctx.prisma.moderationAction.findMany({
      where: { recommendationId: rec.id },
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ action: 'STATUS_CHANGE', actorUserId: staffUserId });
    expect(actions[0].before).toEqual({ status: 'PENDING' });
    expect(actions[0].after).toEqual({ status: 'ACCEPTED' });
  });

  it('records a deletion as DELETE and a restore as RESTORE', async () => {
    const rec = await makeEntry();
    await changeStatus(staff, rec.id, { status: 'DELETED' }).expect(200);
    await changeStatus(staff, rec.id, { status: 'PENDING' }).expect(200);
    const actions = await ctx.prisma.moderationAction.findMany({
      where: { recommendationId: rec.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(actions.map((a) => a.action)).toEqual(['DELETE', 'RESTORE']);
  });

  it('refuses an illegal transition with 409 and writes no audit row', async () => {
    const rec = await makeEntry();
    await changeStatus(staff, rec.id, { status: 'COMPLETED' }).expect(409);
    expect(await ctx.prisma.moderationAction.count({ where: { recommendationId: rec.id } })).toBe(
      0,
    );
    const after = await ctx.prisma.recommendation.findUniqueOrThrow({ where: { id: rec.id } });
    expect(after.status).toBe('PENDING');
  });

  it('refuses a patron, however much they pledge', async () => {
    const rec = await makeEntry();
    await changeStatus(patron, rec.id, { status: 'ACCEPTED' }).expect(403);
  });

  it('refuses an entry belonging to another creator', async () => {
    // The guard proved access to *this* creator; the id is not scoped by it.
    const foreign = await makeEntry(otherCreatorId);
    await changeStatus(staff, foreign.id, { status: 'ACCEPTED' }).expect(404);
  });

  it('rejects an unknown status before touching the database', async () => {
    const rec = await makeEntry();
    await changeStatus(staff, rec.id, { status: 'BANANA' }).expect(400);
  });

  it('lets only one of two identical concurrent transitions win', async () => {
    // Exactly one 200 and exactly one audit row under every interleaving. If both requests read
    // PENDING before either wrote, the unconditional update let both commit — two audit rows for
    // one change, the second claiming a `before` that was no longer true. The write is now
    // conditional on the status the transition map was checked against.
    const rec = await makeEntry();
    const results = await Promise.all([
      changeStatus(staff, rec.id, { status: 'ACCEPTED' }),
      changeStatus(staff, rec.id, { status: 'ACCEPTED' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

    const actions = await ctx.prisma.moderationAction.findMany({
      where: { recommendationId: rec.id },
    });
    expect(actions).toHaveLength(1);
    const row = await ctx.prisma.recommendation.findUniqueOrThrow({ where: { id: rec.id } });
    expect(actions[0].after).toEqual({ status: row.status });
  });

  it('stores the moderator note on the audit row', async () => {
    const rec = await makeEntry();
    await changeStatus(staff, rec.id, { status: 'REJECTED', note: 'off topic' }).expect(200);
    const action = await ctx.prisma.moderationAction.findFirstOrThrow({
      where: { recommendationId: rec.id },
    });
    expect(action.note).toBe('off topic');
  });
});
