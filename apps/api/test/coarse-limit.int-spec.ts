import request from 'supertest';
import { TokenBucketService } from '../src/limits/token-bucket.service';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Coarse request limiter (integration)', () => {
  let ctx: AuthTestContext;
  let buckets: TokenBucketService;
  let creatorId: string;
  let patron: Auth;
  let otherPatron: Auth;
  let entryId: string;

  const originalEnv = { ...process.env };

  beforeAll(async () => {
    // Small enough to reach deliberately, large enough that the "ordinary use" assertion means
    // something. Production defaults are 60/120.
    process.env.COARSE_LIMIT_BURST = '12';
    process.env.COARSE_LIMIT_PER_MINUTE = '1';
    process.env.SEARCH_LIMIT_BURST = '6';
    process.env.SEARCH_LIMIT_PER_MINUTE = '1';
    // One proxy, as in the deployed stack — otherwise every test here shares the socket address
    // and the per-address assertions cannot distinguish themselves from the per-user ones.
    process.env.TRUSTED_PROXY_HOPS = '1';
    ctx = await startAuthApp();
    buckets = ctx.app.get(TokenBucketService);

    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'cl-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'cl-campaign',
        ownerUserId: owner.id,
        displayName: 'Limit Co',
        slug: 'limit-co',
        policy: { create: { viewVisibility: 'PUBLIC' } },
      },
    });
    creatorId = creator.id;

    patron = await loginAs('cl-patron');
    otherPatron = await loginAs('cl-other');
    for (const id of ['cl-patron', 'cl-other']) {
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: id } });
      await ctx.prisma.membership.create({
        data: { userId: user.id, creatorId, amountCents: 500, isActivePatron: true },
      });
    }

    entryId = (
      await ctx.prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: (
            await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'cl-patron' } })
          ).id,
          type: 'EXTERNAL_LINK',
          customTitle: 'Totoro',
          normalizedTitle: 'totoro',
          status: 'ACCEPTED',
        },
      })
    ).id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
    // Restored: process.env is shared across suites under --runInBand, and leaving a burst of 12
    // behind made later suites fail on a limiter they were not testing.
    for (const key of [
      'TRUSTED_PROXY_HOPS',
      'COARSE_LIMIT_BURST',
      'COARSE_LIMIT_PER_MINUTE',
      'SEARCH_LIMIT_BURST',
      'SEARCH_LIMIT_PER_MINUTE',
    ]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  beforeEach(async () => {
    await ctx.limits.reset();
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

  const upvote = (auth: Auth) =>
    request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/limit-co/recommendations/${entryId}/upvote`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken);

  const board = (auth: Auth) =>
    request(ctx.app.getHttpServer())
      .get('/api/v1/creators/limit-co/recommendations')
      .set('Cookie', [auth.session, auth.csrf]);

  const search = (auth: Auth) =>
    request(ctx.app.getHttpServer())
      .get('/api/v1/creators/limit-co/recommendations/similar?q=totoro')
      .set('Cookie', [auth.session, auth.csrf]);

  async function spend(auth: Auth, times: number) {
    let last = 0;
    for (let i = 0; i < times; i += 1) last = (await upvote(auth)).status;
    return last;
  }

  it('lets ordinary use through', async () => {
    // Design §6.2 wants a velocity cap that does not hinder normal use: toggling an upvote a
    // handful of times must never reach it.
    for (let i = 0; i < 8; i += 1) {
      expect([200, 201]).toContain((await upvote(patron)).status);
    }
  });

  it('refuses once the burst is spent, with a Retry-After', async () => {
    await spend(patron, 12);
    const refused = await upvote(patron);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('says nothing about the rule', async () => {
    await spend(patron, 12);
    const refused = await upvote(patron);
    expect(JSON.stringify(refused.body)).not.toMatch(/bucket|token|per minute|limit of/i);
  });

  it('does not limit ordinary reads', async () => {
    for (let i = 0; i < 30; i += 1) await board(patron).expect(200);
  });

  it('limits search, which is the one read with a measured cost', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await search(patron)).status);
    expect(statuses).toContain(429);
  });

  it('keeps the search bucket separate from the mutating one', async () => {
    // Tightening one later must not silently throttle the other.
    for (let i = 0; i < 12; i += 1) await search(patron);
    expect([200, 201]).toContain((await upvote(patron)).status);
  });

  it('limits a second user from the same address', async () => {
    // Per-user alone would let one person spread across accounts; the IP bucket catches it.
    await spend(patron, 12);
    expect((await upvote(otherPatron)).status).toBe(429);
  });

  it('limits one user arriving from many addresses', async () => {
    // The other half of design §6.2's "keyed by IP *and* user". Every test above is satisfiable
    // by the IP bucket alone, because they all share one socket — deleting the user bucket
    // entirely left the whole suite green.
    const from = async (address: string, times: number) => {
      let last = 0;
      for (let i = 0; i < times; i += 1) {
        last = (
          await request(ctx.app.getHttpServer())
            .post(`/api/v1/creators/limit-co/recommendations/${entryId}/upvote`)
            .set('Cookie', [patron.session, patron.csrf])
            .set('x-csrf-token', patron.csrfToken)
            .set('x-forwarded-for', `client, ${address}`)
        ).status;
      }
      return last;
    };
    // Exactly the burst from one address: that address's bucket is empty and so is the user's.
    await from('198.51.100.1', 12);
    // A single request from a *different* address, whose bucket is untouched. Only the user
    // bucket can refuse this one — sending more than the burst here would let the address
    // bucket refuse it too, which is what made an earlier version of this test pass with the
    // user bucket deleted.
    expect(await from('198.51.100.2', 1)).toBe(429);
  });

  it('limits an anonymous caller by address alone', async () => {
    // No session, so there is no user bucket to fall back on.
    const statuses: number[] = [];
    for (let i = 0; i < 14; i += 1) {
      statuses.push(
        (
          await request(ctx.app.getHttpServer())
            .get('/api/v1/creators/limit-co/recommendations/similar?q=totoro')
            .set('x-forwarded-for', 'client, 203.0.113.50')
        ).status,
      );
    }
    expect(statuses).toContain(429);
  });

  it('does not limit webhook deliveries', async () => {
    // Patreon's deliveries all arrive from one egress range; a bucket sized for a human clicking
    // upvote would 429 a campaign's charge-day traffic and leave membership state stale. The
    // HMAC is the gate there.
    await spend(patron, 14);
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/webhooks/patreon/${creatorId}`)
      .set('x-patreon-signature', 'nope')
      .send({});
    expect(res.status).not.toBe(429);
  });

  it('proceeds when the bucket store is unavailable', async () => {
    // A limiter is a safety margin. Failing closed would turn a Redis blip into an outage.
    const original = buckets.take.bind(buckets);
    (buckets as { take: unknown }).take = async () => {
      throw new Error('redis down');
    };
    try {
      expect([200, 201]).toContain((await upvote(patron)).status);
    } finally {
      (buckets as { take: unknown }).take = original;
    }
  });
});
