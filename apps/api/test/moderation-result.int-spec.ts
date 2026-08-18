import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Moderation results (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let patron: Auth;
  let patronUserId: string;
  let staff: Auth;
  let recId: string;

  const originalLimits = {
    perHour: process.env.SUBMIT_LIMIT_PER_HOUR,
    global: process.env.SUBMIT_LIMIT_PER_HOUR_GLOBAL,
  };

  beforeAll(async () => {
    // Set before the app boots, since config is validated once at startup. Scoped to this suite
    // and restored below: raising it in the shared defaults would have switched off the test that
    // proves the cap works at all.
    process.env.SUBMIT_LIMIT_PER_HOUR = '1000';
    process.env.SUBMIT_LIMIT_PER_HOUR_GLOBAL = '1000';
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'mr-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'mr-campaign',
        ownerUserId: owner.id,
        displayName: 'Result Co',
        slug: 'result-co',
        policy: { create: {} },
        staff: { create: { userId: owner.id, role: 'OWNER' } },
      },
    });
    creatorId = creator.id;

    patron = await loginAs('mr-patron');
    patronUserId = (
      await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'mr-patron' } })
    ).id;
    await ctx.prisma.membership.create({
      data: { userId: patronUserId, creatorId, amountCents: 500, isActivePatron: true },
    });
    staff = await loginAs('mr-staff');
    await ctx.prisma.creatorStaff.create({
      data: {
        creatorId,
        userId: (await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'mr-staff' } }))
          .id,
        role: 'MOD',
      },
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
    restore('SUBMIT_LIMIT_PER_HOUR', originalLimits.perHour);
    restore('SUBMIT_LIMIT_PER_HOUR_GLOBAL', originalLimits.global);
  });

  function restore(key: string, value: string | undefined) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  beforeEach(async () => {
    // A BLOCK earns an abuse strike, which is the product working — but a suite that blocks
    // several times in a row would end up testing the timeout it did not come here for.
    await ctx.prisma.abuseRecord.deleteMany();
    await ctx.prisma.moderationResult.deleteMany();
    await ctx.prisma.creatorNote.deleteMany();
    await ctx.prisma.recommendation.deleteMany();
    recId = (
      await ctx.prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: patronUserId,
          type: 'MOVIE',
          customTitle: 'A Film',
          normalizedTitle: 'a film',
        },
      })
    ).id;
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

  const submit = (auth: Auth, customTitle: string) =>
    request(ctx.app.getHttpServer())
      .post('/api/v1/creators/result-co/recommendations')
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({
        type: 'EXTERNAL_LINK',
        customTitle,
        links: [{ url: 'https://example.com/a', label: 'Watch' }],
      });

  it('records a block, with no subject id because nothing was created', async () => {
    await submit(patron, 'this is shit').expect(400);

    const rows = await ctx.prisma.moderationResult.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      creatorId,
      userId: patronUserId,
      subjectType: 'RECOMMENDATION',
      // The entry was rejected and never created, which is exactly the case the record is
      // evidence for — there is nothing to point at.
      subjectId: null,
      verdict: 'BLOCK',
      source: 'WORDLIST',
      categories: ['PROFANITY'],
    });
  });

  it('records nothing for text that passes', async () => {
    await submit(patron, 'A perfectly ordinary film').expect(201);

    // PASS is the absence of a row: everything a user writes comes through the pipeline and
    // almost all of it passes, so recording those is a table nobody reads.
    expect(await ctx.prisma.moderationResult.count()).toBe(0);
  });

  it('keeps the offending text out of the record', async () => {
    // A BLOCK on a slur would otherwise mean the database keeps that slur for ever, on a row
    // nobody reads, for a board that never accepted it.
    await submit(patron, 'this is shit').expect(400);

    const [row] = await ctx.prisma.$queryRaw<Array<{ t: string }>>`
      SELECT row_to_json(m)::text AS t FROM "ModerationResult" m
    `;
    expect(row.t).not.toMatch(/shit/i);
  });

  it('records a blocked note against the entry it was written on', async () => {
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/result-co/recommendations/${recId}/notes`)
      .set('Cookie', [staff.session, staff.csrf])
      .set('x-csrf-token', staff.csrfToken)
      .send({ body: 'this is shit', kind: 'NOTE' })
      .expect(400);

    const [row] = await ctx.prisma.moderationResult.findMany();
    // The note was refused, but the entry it targeted exists and is what a moderator would look
    // at, so the record points there rather than nowhere.
    expect(row).toMatchObject({ subjectType: 'NOTE', subjectId: recId });
  });

  it('records a blocked report note', async () => {
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/result-co/recommendations/${recId}/flags`)
      .set('Cookie', [patron.session, patron.csrf])
      .set('x-csrf-token', patron.csrfToken)
      .send({ reason: 'SPAM', note: 'this is shit' })
      .expect(400);

    const [row] = await ctx.prisma.moderationResult.findMany();
    expect(row).toMatchObject({
      subjectType: 'FLAG_NOTE',
      subjectId: recId,
      userId: patronUserId,
    });
  });

  it('keeps one board results out of another board', async () => {
    const other = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'mr-other',
        ownerUserId: (
          await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'mr-owner' } })
        ).id,
        displayName: 'Other',
        slug: 'mr-other',
        policy: { create: {} },
      },
    });

    await submit(patron, 'this is shit').expect(400);

    expect(await ctx.prisma.moderationResult.count({ where: { creatorId: other.id } })).toBe(0);
    expect(await ctx.prisma.moderationResult.count({ where: { creatorId } })).toBe(1);
    await ctx.prisma.creator.delete({ where: { id: other.id } });
  });

  it('goes when the board goes', async () => {
    await submit(patron, 'this is shit').expect(400);
    expect(await ctx.prisma.moderationResult.count()).toBe(1);

    await ctx.prisma.creator.delete({ where: { id: creatorId } });

    expect(await ctx.prisma.moderationResult.count()).toBe(0);
  });
});
