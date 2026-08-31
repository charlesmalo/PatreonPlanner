import request from 'supertest';
import { AuthTestContext, startAuthApp } from './support/auth-app';

/**
 * What the limiter does when it is told there is no proxy in front of it and the address it sees
 * looks like one anyway.
 *
 * `RateLimitGuard` skips the per-address bucket in that case, and the reason is in its own
 * comment: bucketing the whole internet together turns the limiter into a lever anyone can pull
 * to refuse everyone else's writes. Until now only `looksLikeProxy` was tested — the predicate,
 * never the guard's use of it — so nothing held down the behaviour that actually matters.
 *
 * Its own suite because the choice is made at boot from configuration, and every other suite
 * deliberately sets one proxy so that loopback is treated as a client.
 */
describe('Per-address limiting behind an untrusted proxy (integration)', () => {
  let ctx: AuthTestContext;
  const originalEnv = { ...process.env };

  const BURST = 3;

  beforeAll(async () => {
    // Small enough to cross in a handful of requests, and per-minute set to 1 so refill cannot
    // rescue the assertion.
    process.env.SEARCH_LIMIT_BURST = String(BURST);
    process.env.SEARCH_LIMIT_PER_MINUTE = '1';
    // The production default, and the case this suite exists for: nothing has told us how many
    // proxies sit in front, and supertest connects over loopback — which `looksLikeProxy` treats
    // as a proxy rather than a client.
    process.env.TRUSTED_PROXY_HOPS = '0';
    ctx = await startAuthApp();
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
    for (const key of ['SEARCH_LIMIT_BURST', 'SEARCH_LIMIT_PER_MINUTE', 'TRUSTED_PROXY_HOPS']) {
      // Restored: process.env is shared across suites under --runInBand, and a burst of 3 left
      // behind would fail later suites on a limiter they are not testing.
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  beforeEach(async () => {
    await ctx.limits.reset();
  });

  /**
   * A rate-limited GET, anonymous.
   *
   * A GET on purpose: CSRF is middleware and rejects an unauthenticated POST at 403 *before* any
   * guard runs, so a mutating request would have proved nothing about the limiter — the first
   * version of this suite used one and passed whether the skip worked or not.
   *
   * Anonymous on purpose too: no session means no per-user bucket, so the address is the only
   * thing that could refuse it.
   */
  const search = () =>
    request(ctx.app.getHttpServer()).get('/api/v1/creators/nobody/catalog/search?q=akira');

  it('does not refuse anonymous traffic that all shares one apparent address', async () => {
    // The point. With the address bucket skipped and no user to bucket by, nothing here is rate
    // limited — which is the correct answer to "we cannot tell these callers apart". Refusing
    // instead would mean one person's requests could exhaust everybody else's allowance.
    const statuses: number[] = [];
    for (let i = 0; i < BURST + 3; i += 1) {
      statuses.push((await search()).status);
    }

    expect(statuses).not.toContain(429);
  });

  it('still answers each request on its own merits', async () => {
    // Skipping the limiter must not skip anything else: this is refused for what it is — a board
    // that does not exist — rather than waved through because the address could not be trusted.
    const res = await search();

    expect(res.status).toBe(404);
  });
});
