import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { AppModule } from '../src/app.module';

describe('GET /readyz (integration)', () => {
  let app: INestApplication;
  let pg: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    redis = await new RedisContainer('redis:7-alpine').start();
    process.env.DATABASE_URL = pg.getConnectionUri();
    process.env.REDIS_URL = redis.getConnectionUrl();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pg.stop();
    await redis.stop();
  });

  it('reports ready when db and redis are up', async () => {
    const res = await request(app.getHttpServer()).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', checks: { db: true, redis: true } });
  });
});
