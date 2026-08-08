import { createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { ConfigModule } from '../src/config/config.module';
import { RedisModule } from '../src/redis/redis.module';
import { RedisService } from '../src/redis/redis.service';
import { OAuthStateService } from '../src/auth/oauth-state.service';
import { applyTestConfigDefaults } from './support/env';

describe('OAuthStateService (integration)', () => {
  let redis: StartedRedisContainer;
  let states: OAuthStateService;
  let redisService: RedisService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start();
    process.env.REDIS_URL = redis.getConnectionUrl();
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
    applyTestConfigDefaults();

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, RedisModule],
      providers: [OAuthStateService],
    }).compile();
    await moduleRef.init();
    states = moduleRef.get(OAuthStateService);
    redisService = moduleRef.get(RedisService);
    close = () => moduleRef.close();
  }, 120_000);

  afterAll(async () => {
    await close();
    await redis.stop();
  });

  it('derives the challenge as the S256 hash of the stored verifier', async () => {
    const { state, codeChallenge } = await states.start();
    const verifier = await states.consume(state);
    expect(verifier).not.toBeNull();
    const expected = createHash('sha256')
      .update(verifier as string)
      .digest('base64url');
    expect(codeChallenge).toBe(expected);
  });

  it('refuses to replay a state', async () => {
    const { state } = await states.start();
    expect(await states.consume(state)).not.toBeNull();
    expect(await states.consume(state)).toBeNull();
  });

  it('returns null for a state it never issued', async () => {
    expect(await states.consume('forged-state')).toBeNull();
  });

  it('issues a distinct state and verifier every time', async () => {
    const first = await states.start();
    const second = await states.start();
    expect(first.state).not.toBe(second.state);
    expect(first.codeChallenge).not.toBe(second.codeChallenge);
  });

  it('expires a pending state rather than leaving it indefinitely', async () => {
    const { state } = await states.start();
    // A pending state is an unauthenticated write; it must not accumulate forever.
    const keys = await redisService.raw().keys('oauth-state:*');
    const matching = keys.find((key) => key.endsWith(state)) as string;
    const ttl = await redisService.raw().ttl(matching);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
  });
});
