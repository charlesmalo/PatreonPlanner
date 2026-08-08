import { Test } from '@nestjs/testing';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { ConfigModule } from '../src/config/config.module';
import { RedisModule } from '../src/redis/redis.module';
import { RedisService } from '../src/redis/redis.service';
import { SessionModule } from '../src/session/session.module';
import { SessionService } from '../src/session/session.service';
import { applyTestConfigDefaults } from './support/env';

describe('SessionService (integration)', () => {
  let redis: StartedRedisContainer;
  let sessions: SessionService;
  let redisService: RedisService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start();
    process.env.REDIS_URL = redis.getConnectionUrl();
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
    applyTestConfigDefaults();

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, RedisModule, SessionModule],
    }).compile();
    await moduleRef.init();
    sessions = moduleRef.get(SessionService);
    redisService = moduleRef.get(RedisService);
    close = () => moduleRef.close();
  }, 120_000);

  afterAll(async () => {
    await close();
    await redis.stop();
  });

  it('resolves a freshly created session to its user', async () => {
    const token = await sessions.create('user-1');
    expect(await sessions.resolve(token)).toBe('user-1');
  });

  it('returns null for an unknown token', async () => {
    expect(await sessions.resolve('not-a-real-token')).toBeNull();
  });

  it('stops resolving a destroyed session', async () => {
    const token = await sessions.create('user-2');
    await sessions.destroy(token);
    expect(await sessions.resolve(token)).toBeNull();
  });

  it('issues a distinct token per session', async () => {
    expect(await sessions.create('user-3')).not.toBe(await sessions.create('user-3'));
  });

  it('never stores the raw token in redis', async () => {
    const token = await sessions.create('user-4');
    // Read through the Redis client directly rather than a debug hook on the service: the
    // production class should carry no test-only surface.
    const keys = await redisService.raw().keys('*');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join(' ')).not.toContain(token);
  });

  it('drops every session for a user on demand', async () => {
    const first = await sessions.create('user-5');
    const second = await sessions.create('user-5');
    await sessions.destroyAllForUser('user-5');
    expect(await sessions.resolve(first)).toBeNull();
    expect(await sessions.resolve(second)).toBeNull();
  });

  it('expires a session at the configured ttl', async () => {
    const token = await sessions.create('user-6');
    const ttl = await redisService.raw().ttl((await redisService.raw().keys('sess:*'))[0]);
    expect(ttl).toBeGreaterThan(0);
    expect(await sessions.resolve(token)).toBe('user-6');
  });
});
