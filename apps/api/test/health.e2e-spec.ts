import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('GET /healthz', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5433/planner';
    process.env.REDIS_URL = 'redis://localhost:6379';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
  });

  it('returns 200 with status ok', async () => {
    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
