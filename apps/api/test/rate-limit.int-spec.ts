import { Test } from '@nestjs/testing';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { ConfigModule } from '../src/config/config.module';
import { LimitsModule } from '../src/limits/limits.module';
import { RateLimitService } from '../src/limits/rate-limit.service';
import { RedisModule } from '../src/redis/redis.module';
import { RedisService } from '../src/redis/redis.service';
import { applyTestConfigDefaults } from './support/env';

describe('RateLimitService (integration)', () => {
  let redis: StartedRedisContainer;
  let limiter: RateLimitService;
  let redisService: RedisService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start();
    process.env.REDIS_URL = redis.getConnectionUrl();
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
    applyTestConfigDefaults();

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, RedisModule, LimitsModule],
    }).compile();
    await moduleRef.init();
    limiter = moduleRef.get(RateLimitService);
    redisService = moduleRef.get(RedisService);
    close = () => moduleRef.close();
  }, 120_000);

  afterAll(async () => {
    await close();
    await redis.stop();
  });

  it('allows up to the limit then refuses', async () => {
    expect(await limiter.consume('k1', 2, 60)).toBe(true);
    expect(await limiter.consume('k1', 2, 60)).toBe(true);
    expect(await limiter.consume('k1', 2, 60)).toBe(false);
  });

  it('keeps separate keys independent', async () => {
    expect(await limiter.consume('k2', 1, 60)).toBe(true);
    expect(await limiter.consume('k3', 1, 60)).toBe(true);
  });

  it('always sets a TTL, so a caller can never be locked out permanently', async () => {
    await limiter.consume('k4', 1, 60);
    // INCR and EXPIRE run as one script: issued separately, a failure between them leaves a key
    // with no expiry and the caller blocked forever, which design §9 forbids.
    expect(await redisService.raw().ttl('ratelimit:k4')).toBeGreaterThan(0);
  });

  it('does not extend the window on later calls', async () => {
    await limiter.consume('k5', 5, 3);
    await new Promise((r) => setTimeout(r, 1100));
    await limiter.consume('k5', 5, 3);
    // Otherwise a steady stream of calls could hold one window open indefinitely.
    expect(await redisService.raw().ttl('ratelimit:k5')).toBeLessThanOrEqual(2);
  });

  it('expires the window', async () => {
    expect(await limiter.consume('k6', 1, 1)).toBe(true);
    expect(await limiter.consume('k6', 1, 1)).toBe(false);
    await new Promise((r) => setTimeout(r, 1300));
    expect(await limiter.consume('k6', 1, 1)).toBe(true);
  });

  it('gives an allowance back on refund', async () => {
    expect(await limiter.consume('k7', 1, 60)).toBe(true);
    await limiter.refund('k7');
    expect(await limiter.consume('k7', 1, 60)).toBe(true);
  });

  it('never refunds below zero', async () => {
    await limiter.refund('k8');
    await limiter.refund('k8');
    // A negative counter would hand out extra allowance on the next window.
    expect(Number((await redisService.raw().get('ratelimit:k8')) ?? 0)).toBeGreaterThanOrEqual(0);
  });
});
