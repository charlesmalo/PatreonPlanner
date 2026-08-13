import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { AppModule } from '../src/app.module';
import { applyTestConfigDefaults } from './support/env';

// Generous next to the ~2s check timeout, but far below the ~20s ioredis spends exhausting its
// default reconnect budget — the failure this asserts against.
const READINESS_BUDGET_MS = 5_000;

describe('GET /readyz (integration)', () => {
  let app: INestApplication;
  let pg: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let redisStopped = false;

  // Its own containers, not the shared pair: this suite stops Redis on purpose to prove /readyz
  // degrades, and stopping the server every other suite depends on would end the run.
  beforeAll(async () => {
    pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    redis = await new RedisContainer('redis:7-alpine').start();
    process.env.DATABASE_URL = pg.getConnectionUri();
    process.env.REDIS_URL = redis.getConnectionUrl();
    applyTestConfigDefaults();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    // One listener for the suite; see the note in support/auth-app.ts.
    await app.listen(0);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pg.stop();
    if (!redisStopped) await redis.stop();
  });

  it('reports ready when db and redis are up', async () => {
    const res = await request(app.getHttpServer()).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', checks: { db: true, redis: true } });
  });

  // A readiness probe that blocks is worse than one that answers 503: orchestrators give up
  // on the probe long before ioredis exhausts its reconnect budget.
  it('reports unready promptly when redis is down', async () => {
    await redis.stop();
    redisStopped = true;

    const startedAt = Date.now();
    const res = await request(app.getHttpServer()).get('/readyz');
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unready', checks: { db: true, redis: false } });
    expect(elapsedMs).toBeLessThan(READINESS_BUDGET_MS);
  }, 60_000);
});
