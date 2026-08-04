import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

// Local docker-compose defaults. A caller-supplied environment (CI, where the services run on
// their own ports) always wins, so only the keys we actually injected get cleaned up afterwards.
const ENV_DEFAULTS: Record<string, string> = {
  DATABASE_URL: 'postgresql://planner:planner@localhost:5433/planner',
  REDIS_URL: 'redis://localhost:6379',
};
const injectedKeys = Object.keys(ENV_DEFAULTS).filter((key) => process.env[key] === undefined);

describe('GET /healthz', () => {
  let app: INestApplication;

  beforeAll(async () => {
    for (const key of injectedKeys) process.env[key] = ENV_DEFAULTS[key];
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    for (const key of injectedKeys) delete process.env[key];
  });

  it('returns 200 with status ok', async () => {
    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
