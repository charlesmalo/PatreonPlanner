import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Review queue (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let otherCreatorId: string;
  let staff: Auth;
  let staffUserId: string;
  let patron: Auth;
  let otherPatron: Auth;
  let patronUserId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'rq-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'rq-campaign',
        ownerUserId: owner.id,
        displayName: 'Queue Co',
        slug: 'queue-co',
        policy: { create: {} },
      },
    });
    creatorId = creator.id;
    const other = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'rq-other-campaign',
        ownerUserId: owner.id,
        displayName: 'Other Queue',
        slug: 'rq-other',
        policy: { create: {} },
      },
    });
    otherCreatorId = other.id;

    staff = await loginAs('rq-staff');
    staffUserId = (
      await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'rq-staff' } })
    ).id;
    await ctx.prisma.creatorStaff.create({ data: { creatorId, userId: staffUserId, role: 'MOD' } });

    patron = await loginAs('rq-patron');
    patronUserId = (
      await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'rq-patron' } })
    ).id;
    await ctx.prisma.membership.create({
      data: { userId: patronUserId, creatorId, amountCents: 500, isActivePatron: true },
    });
    otherPatron = await loginAs('rq-other-patron');
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    // Ordering assertions need a known set, and flags cascade with their entries.
    await ctx.prisma.recommendation.deleteMany({ where: { creatorId } });
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
  async function makeEntry(
    opts: {
      status?: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'DELETED';
      description?: string;
      creator?: string;
    } = {},
  ) {
    counter += 1;
    return ctx.prisma.recommendation.create({
      data: {
        creatorId: opts.creator ?? creatorId,
        submittedByUserId: patronUserId,
        type: 'EXTERNAL_LINK',
        customTitle: `Queued ${counter}`,
        normalizedTitle: `queued ${counter}`,
        status: opts.status ?? 'PENDING',
        description: opts.description,
      },
    });
  }

  const flagAs = (auth: Auth, id: string, slug = 'queue-co') =>
    request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/${slug}/recommendations/${id}/flags`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ reason: 'SPAM', note: 'please look' });

  const queue = (auth: Auth, slug = 'queue-co') =>
    request(ctx.app.getHttpServer())
      .get(`/api/v1/creators/${slug}/review-queue`)
      .set('Cookie', [auth.session, auth.csrf]);

  const patch = (auth: Auth, path: string, body: object) =>
    request(ctx.app.getHttpServer())
      .patch(`/api/v1${path}`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  it('orders flagged entries ahead of unflagged ones, most-flagged first', async () => {
    const quiet = await makeEntry();
    const once = await makeEntry();
    const twice = await makeEntry();
    await flagAs(patron, once.id).expect(201);
    await flagAs(patron, twice.id).expect(201);
    await flagAs(otherPatron, twice.id).expect(201);

    const res = await queue(staff).expect(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([twice.id, once.id, quiet.id]);
    expect(res.body.items[0].openFlagCount).toBe(2);
    expect(res.body.items[2].openFlagCount).toBe(0);
  });

  it('exposes each flag reason and note to the moderator', async () => {
    const rec = await makeEntry();
    await flagAs(patron, rec.id).expect(201);
    const res = await queue(staff).expect(200);
    expect(res.body.items[0].flags).toEqual([
      expect.objectContaining({ reason: 'SPAM', note: 'please look' }),
    ]);
  });

  it('includes rejected and deleted entries so the bin is reachable', async () => {
    const deleted = await makeEntry({ status: 'DELETED' });
    const rejected = await makeEntry({ status: 'REJECTED' });
    const res = await queue(staff).expect(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual(
      expect.arrayContaining([deleted.id, rejected.id]),
    );
  });

  it('refuses a patron', async () => {
    await queue(patron).expect(403);
  });

  it('never returns another creator entries', async () => {
    await makeEntry({ creator: otherCreatorId });
    const mine = await makeEntry();
    const res = await queue(staff).expect(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([mine.id]);
  });

  it('redacts text and keeps the original only in the audit log', async () => {
    const rec = await makeEntry({ description: 'original text' });
    await patch(staff, `/creators/queue-co/recommendations/${rec.id}`, {
      description: '[removed]',
    }).expect(200);

    const row = await ctx.prisma.recommendation.findUniqueOrThrow({ where: { id: rec.id } });
    expect(row.description).toBe('[removed]');
    const action = await ctx.prisma.moderationAction.findFirstOrThrow({
      where: { recommendationId: rec.id, action: 'EDIT' },
    });
    expect(action.before).toMatchObject({ description: 'original text' });
    expect(action.after).toMatchObject({ description: '[removed]' });
  });

  it('snapshots only the fields the request changed', async () => {
    const rec = await makeEntry({ description: 'keep me' });
    await patch(staff, `/creators/queue-co/recommendations/${rec.id}`, {
      customTitle: 'Redacted',
    }).expect(200);
    const action = await ctx.prisma.moderationAction.findFirstOrThrow({
      where: { recommendationId: rec.id, action: 'EDIT' },
    });
    expect(action.before).toEqual({ customTitle: expect.any(String) });
  });

  it('refuses a redaction from a patron', async () => {
    const rec = await makeEntry();
    await patch(patron, `/creators/queue-co/recommendations/${rec.id}`, {
      customTitle: 'mine now',
    }).expect(403);
  });

  it('runs redacted text through moderation', async () => {
    const rec = await makeEntry();
    await patch(staff, `/creators/queue-co/recommendations/${rec.id}`, {
      customTitle: 'this is shit',
    }).expect(400);
  });

  it('rejects an empty redaction rather than writing an empty audit row', async () => {
    const rec = await makeEntry();
    await patch(staff, `/creators/queue-co/recommendations/${rec.id}`, {}).expect(400);
    expect(await ctx.prisma.moderationAction.count({ where: { recommendationId: rec.id } })).toBe(
      0,
    );
  });

  it('resolves a flag and records who resolved it', async () => {
    const rec = await makeEntry();
    await flagAs(patron, rec.id).expect(201);
    const flag = await ctx.prisma.flag.findFirstOrThrow({ where: { recommendationId: rec.id } });

    await patch(staff, `/creators/queue-co/flags/${flag.id}`, { status: 'RESOLVED' }).expect(200);
    const row = await ctx.prisma.flag.findUniqueOrThrow({ where: { id: flag.id } });
    expect(row).toMatchObject({ status: 'RESOLVED', resolvedByUserId: staffUserId });
    expect(row.resolvedAt).not.toBeNull();

    const action = await ctx.prisma.moderationAction.findFirstOrThrow({
      where: { recommendationId: rec.id },
    });
    expect(action.action).toBe('FLAG_RESOLVED');
  });

  it('drops a resolved flag out of the open count', async () => {
    const rec = await makeEntry();
    await flagAs(patron, rec.id).expect(201);
    const flag = await ctx.prisma.flag.findFirstOrThrow({ where: { recommendationId: rec.id } });
    await patch(staff, `/creators/queue-co/flags/${flag.id}`, { status: 'DISMISSED' }).expect(200);

    const res = await queue(staff).expect(200);
    expect(res.body.items[0].openFlagCount).toBe(0);
  });

  it('refuses to resolve a flag belonging to another creator board', async () => {
    const foreign = await makeEntry({ creator: otherCreatorId });
    const foreignFlag = await ctx.prisma.flag.create({
      data: { recommendationId: foreign.id, flaggedByUserId: patronUserId, reason: 'SPAM' },
    });
    // A flag id alone says nothing about which board it belongs to.
    await patch(staff, `/creators/queue-co/flags/${foreignFlag.id}`, {
      status: 'RESOLVED',
    }).expect(404);
  });

  it('refuses to move a flag back to OPEN', async () => {
    const rec = await makeEntry();
    await flagAs(patron, rec.id).expect(201);
    const flag = await ctx.prisma.flag.findFirstOrThrow({ where: { recommendationId: rec.id } });
    await patch(staff, `/creators/queue-co/flags/${flag.id}`, { status: 'OPEN' }).expect(400);
  });
});
