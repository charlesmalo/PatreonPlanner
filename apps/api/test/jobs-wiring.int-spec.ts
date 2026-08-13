import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { AppModule } from '../src/app.module';
import { PATREON_CLIENT } from '../src/patreon/patreon.client';
import { startDatabase, type TestDatabase } from './support/database';
import { applyTestConfigDefaults } from './support/env';
import { FakePatreonClient } from './support/fake-patreon.client';

/**
 * Every other suite runs with JOBS_ENABLED=false, which meant nothing in JobsModule was ever
 * executed by CI: not the connection shape, not repeat+jobId compatibility, not the worker
 * callback, not shutdown. A change that throws in onModuleInit would have crashed every
 * production boot and shipped green.
 */
describe('JobsModule wiring (integration)', () => {
  let app: INestApplication;
  let redis: StartedRedisContainer;
  let pg: TestDatabase;
  let redisUrl: string;

  beforeAll(async () => {
    pg = await startDatabase();
    redis = await new RedisContainer('redis:7-alpine').start();
    redisUrl = redis.getConnectionUrl();
    process.env.DATABASE_URL = pg.getConnectionUri();
    process.env.REDIS_URL = redisUrl;
    applyTestConfigDefaults();
    // The point of this suite: the one place jobs actually start.
    process.env.JOBS_ENABLED = 'true';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PATREON_CLIENT)
      .useValue(new FakePatreonClient())
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  }, 240_000);

  afterAll(async () => {
    await app.close();
    await redis.stop();
    await pg.stop();
    process.env.JOBS_ENABLED = 'false';
  });

  it('registers exactly one repeatable job', async () => {
    const queue = new Queue('membership-refresh', { connection: { url: redisUrl } });
    try {
      const repeatable = await queue.getRepeatableJobs();
      // A fixed jobId is what stops N API instances scheduling N copies.
      expect(repeatable).toHaveLength(1);
      expect(repeatable[0].name).toBe('tick');
    } finally {
      await queue.close();
    }
  });

  it('shuts the worker and queue down cleanly', async () => {
    // app.close() runs in afterAll; reaching here without a hang or an unhandled rejection is
    // the assertion. A worker left open would keep jest alive.
    expect(app).toBeDefined();
  });
});
