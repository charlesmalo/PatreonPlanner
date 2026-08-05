import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

// /healthz is a liveness probe: it answers "the process is up" and deliberately touches no
// dependency. Booting AppModule against real Postgres and Redis would make this suite report
// "liveness broken" whenever the infrastructure it does not exercise happens to be down.
const stubPrisma = {
  onModuleInit: async (): Promise<void> => {},
  onModuleDestroy: async (): Promise<void> => {},
  ping: async (): Promise<boolean> => true,
};
const stubRedis = {
  onModuleInit: async (): Promise<void> => {},
  onModuleDestroy: async (): Promise<void> => {},
  ping: async (): Promise<boolean> => true,
};

// ConfigService still validates the environment at construction, so these must parse as URLs.
const ENV_DEFAULTS: Record<string, string> = {
  DATABASE_URL: 'postgresql://planner:planner@localhost:5432/planner',
  REDIS_URL: 'redis://localhost:6379',
};
const injectedKeys = Object.keys(ENV_DEFAULTS).filter((key) => process.env[key] === undefined);

describe('GET /healthz', () => {
  let app: INestApplication;

  beforeAll(async () => {
    for (const key of injectedKeys) process.env[key] = ENV_DEFAULTS[key];
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(stubPrisma)
      .overrideProvider(RedisService)
      .useValue(stubRedis)
      .compile();
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
