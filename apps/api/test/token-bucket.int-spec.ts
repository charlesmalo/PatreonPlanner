import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { TokenBucketService } from '../src/limits/token-bucket.service';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('TokenBucketService (integration)', () => {
  let redis: StartedRedisContainer;
  let bucket: TokenBucketService;
  let key: string;
  let counter = 0;
  let client: import('ioredis').default;

  beforeAll(async () => {
    // Its own Redis: the shared one is flushed by other suites' setup, and a bucket that gets
    // cleared mid-test would make every assertion here meaningless.
    redis = await new RedisContainer('redis:7-alpine').start();
    const Redis = (await import('ioredis')).default;
    client = new Redis(redis.getConnectionUrl());
    bucket = new TokenBucketService({ raw: () => client } as never);
  }, 240_000);

  afterAll(async () => {
    // Quit before stopping the container: an open ioredis connection keeps the Node event loop
    // alive and the suite never exits, which in CI is a hang rather than a failure.
    await client.quit();
    await redis.stop();
  });

  beforeEach(() => {
    counter += 1;
    key = `k${counter}`;
  });

  it('allows a burst up to the capacity', async () => {
    for (let i = 0; i < 5; i += 1) expect((await bucket.take(key, 5, 1)).allowed).toBe(true);
  });

  it('refuses once the burst is spent', async () => {
    for (let i = 0; i < 5; i += 1) await bucket.take(key, 5, 1);
    expect((await bucket.take(key, 5, 1)).allowed).toBe(false);
  });

  it('says when to come back, and never says zero', async () => {
    // A Retry-After of 0 invites an immediate retry that cannot succeed.
    for (let i = 0; i < 5; i += 1) await bucket.take(key, 5, 1);
    const refused = await bucket.take(key, 5, 1);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('refills over time', async () => {
    for (let i = 0; i < 2; i += 1) await bucket.take(key, 2, 20);
    expect((await bucket.take(key, 2, 20)).allowed).toBe(false);
    await sleep(150);
    expect((await bucket.take(key, 2, 20)).allowed).toBe(true);
  });

  it('never banks more than the capacity while idle', async () => {
    // Otherwise a long quiet period buys an unbounded burst.
    await bucket.take(key, 3, 1000);
    await sleep(200);
    let allowed = 0;
    for (let i = 0; i < 20; i += 1) if ((await bucket.take(key, 3, 0.0001)).allowed) allowed += 1;
    expect(allowed).toBeLessThanOrEqual(3);
  });

  it('keeps keys apart', async () => {
    for (let i = 0; i < 3; i += 1) await bucket.take(key, 3, 0.0001);
    expect((await bucket.take(key, 3, 0.0001)).allowed).toBe(false);
    expect((await bucket.take(`${key}-other`, 3, 0.0001)).allowed).toBe(true);
  });

  it('is atomic under concurrency', async () => {
    // Read-then-write would let ten simultaneous requests all see a full bucket.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => bucket.take(key, 3, 0.0001)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });

  it('allows the request when Redis is unreachable, rather than failing closed', async () => {
    // A limiter is a safety margin; a hard dependency turns a cache outage into an API outage.
    const broken = new TokenBucketService({
      raw: () => ({
        eval: () => Promise.reject(new Error('connection refused')),
      }),
    } as never);
    expect(await broken.take(key, 1, 1)).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });
});
