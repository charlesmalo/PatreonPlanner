import request from 'supertest';
import { AbuseService } from '../src/abuse/abuse.service';
import { DUPLICATE_STRIKE_THRESHOLD } from '../src/recommendations/recommendations.service';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Abuse enforcement (integration)', () => {
  let ctx: AuthTestContext;
  let abuse: AbuseService;
  let creatorId: string;
  let patron: Auth;
  let staff: Auth;
  let patronUserId: string;
  let staffUserId: string;
  let existingId: string;

  beforeAll(async () => {
    // The limiter has its own suite; here a 1/hour cap would make every test after the first a
    // 429 for reasons unrelated to what it asserts. The rate-limit strike test sets its own.
    process.env.SUBMIT_LIMIT_PER_HOUR = '50';
    process.env.SUBMIT_LIMIT_PER_HOUR_GLOBAL = '50';
    ctx = await startAuthApp();
    abuse = ctx.app.get(AbuseService);

    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'ae-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'ae-campaign',
        ownerUserId: owner.id,
        displayName: 'Abuse Co',
        slug: 'abuse-co',
        policy: { create: {} },
      },
    });
    creatorId = creator.id;

    patron = await loginAs('ae-patron');
    patronUserId = (
      await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'ae-patron' } })
    ).id;
    await ctx.prisma.membership.create({
      data: { userId: patronUserId, creatorId, amountCents: 500, isActivePatron: true },
    });

    staff = await loginAs('ae-staff');
    staffUserId = (
      await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'ae-staff' } })
    ).id;
    await ctx.prisma.creatorStaff.create({
      data: { creatorId, userId: staffUserId, role: 'MOD' },
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.abuseRecord.deleteMany();
    await ctx.prisma.recommendation.deleteMany({ where: { creatorId } });
    await ctx.limits.reset();
    existingId = (
      await ctx.prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: patronUserId,
          type: 'EXTERNAL_LINK',
          customTitle: 'Already here',
          normalizedTitle: 'already here',
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

  const submit = (auth: Auth, body: object) =>
    request(ctx.app.getHttpServer())
      .post('/api/v1/creators/abuse-co/recommendations')
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  const upvote = (auth: Auth, id: string) =>
    request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/abuse-co/recommendations/${id}/upvote`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken);

  const board = (auth: Auth) =>
    request(ctx.app.getHttpServer())
      .get('/api/v1/creators/abuse-co/recommendations')
      .set('Cookie', [auth.session, auth.csrf]);

  const timeOut = (userId: string) =>
    ctx.prisma.abuseRecord.upsert({
      where: { userId },
      create: {
        userId,
        strikeCount: 3,
        timeoutUntil: new Date(Date.now() + 60 * 60 * 1000),
        lastStrikeAt: new Date(),
      },
      update: { timeoutUntil: new Date(Date.now() + 60 * 60 * 1000) },
    });

  const strikesFor = async (userId: string) =>
    (await ctx.prisma.abuseRecord.findUnique({ where: { userId } }))?.strikeCount ?? 0;

  describe('enforcement', () => {
    it('refuses a submission from a timed-out user and says when it lifts', async () => {
      await timeOut(patronUserId);
      const res = await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'Nope' }).expect(403);
      expect(res.body.retryAt).toBeDefined();
      // And says nothing about why: design §9 wants no probing of the rules.
      expect(JSON.stringify(res.body)).not.toMatch(/strike|abuse|moderation/i);
    });

    it('still lets a timed-out user read and upvote', async () => {
      // Design §6.4: a timeout blocks submission only. Losing a board you paid for is out of
      // proportion to a blocked word.
      await timeOut(patronUserId);
      await board(patron).expect(200);
      await upvote(patron, existingId).expect(201);
    });

    it('costs a timed-out user no rate-limit quota', async () => {
      // Checked before the limiter, so a blocked request does the least possible work.
      await timeOut(patronUserId);
      await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'Nope' }).expect(403);
      await ctx.prisma.abuseRecord.update({
        where: { userId: patronUserId },
        data: { timeoutUntil: null },
      });
      await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'Fine' }).expect(201);
    });

    it('lets a lapsed timeout through', async () => {
      await ctx.prisma.abuseRecord.create({
        data: {
          userId: patronUserId,
          strikeCount: 3,
          timeoutUntil: new Date(Date.now() - 1000),
          lastStrikeAt: new Date(),
        },
      });
      await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'Fine' }).expect(201);
    });
  });

  describe('earning strikes', () => {
    it('strikes on a moderation block', async () => {
      await submit(patron, {
        type: 'EXTERNAL_LINK',
        customTitle: 'this is shit',
      }).expect(400);
      expect(await strikesFor(patronUserId)).toBe(1);
    });

    it('strikes on a rate-limit hit', async () => {
      await ctx.limits.reset();
      const first = await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'One' });
      expect(first.status).toBe(201);
      // Exhaust the window deterministically rather than relying on the configured cap.
      await ctx.limits.exhaust(`submit:${patronUserId}:${creatorId}`);
      await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'Two' }).expect(429);
      expect(await strikesFor(patronUserId)).toBe(1);
    });

    it('strikes the submitter when a moderator upholds a flag', async () => {
      const flag = await ctx.prisma.flag.create({
        data: {
          recommendationId: existingId,
          flaggedByUserId: staffUserId,
          reason: 'SPAM',
        },
      });
      await request(ctx.app.getHttpServer())
        .patch(`/api/v1/creators/abuse-co/flags/${flag.id}`)
        .set('Cookie', [staff.session, staff.csrf])
        .set('x-csrf-token', staff.csrfToken)
        .send({ status: 'RESOLVED' })
        .expect(200);

      expect(await strikesFor(patronUserId)).toBe(1);
      // Never the reporter: striking them would make reporting a weapon against the reporter.
      expect(await strikesFor(staffUserId)).toBe(0);
    });

    it('does not strike on a dismissed flag', async () => {
      // Dismissed means the moderator disagreed with the report.
      const flag = await ctx.prisma.flag.create({
        data: { recommendationId: existingId, flaggedByUserId: staffUserId, reason: 'SPAM' },
      });
      await request(ctx.app.getHttpServer())
        .patch(`/api/v1/creators/abuse-co/flags/${flag.id}`)
        .set('Cookie', [staff.session, staff.csrf])
        .set('x-csrf-token', staff.csrfToken)
        .send({ status: 'DISMISSED' })
        .expect(200);
      expect(await strikesFor(patronUserId)).toBe(0);
    });

    it('does not strike a single duplicate', async () => {
      await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'Already here' }).expect(200);
      expect(await strikesFor(patronUserId)).toBe(0);
    });

    it('strikes after repeated duplicate resubmissions', async () => {
      // Plan 11's review: a refunded duplicate still spent a moderation pass and a catalogue
      // call, so replaying a known duplicate was unlimited and free.
      for (let i = 0; i < DUPLICATE_STRIKE_THRESHOLD; i += 1) {
        await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'Already here' }).expect(200);
      }
      expect(await strikesFor(patronUserId)).toBeGreaterThanOrEqual(1);
    });

    it('never lets a strike failure break the request it was reacting to', async () => {
      // The score is a side effect of a decision already made. A submission must not 500 because
      // the abuse table was busy.
      const original = abuse.strike.bind(abuse);
      abuse.strike = async () => {
        throw new Error('abuse table down');
      };
      try {
        await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'this is shit' }).expect(400);
      } finally {
        abuse.strike = original;
      }
    });
  });
});
