import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { AppModule } from '../../src/app.module';
import { PATREON_CLIENT } from '../../src/patreon/patreon.client';
import { startDatabase } from './database';
import { FakePatreonClient } from './fake-patreon.client';
import { applyTestConfigDefaults } from './env';

export interface AuthTestContext {
  app: INestApplication;
  prisma: PrismaClient;
  patreon: FakePatreonClient;
  teardown: () => Promise<void>;
}

/**
 * Boots the real AppModule against throwaway Postgres and Redis with only the Patreon client
 * faked, so the auth suites exercise genuine routing, guards, cookies and persistence. Shared
 * because three suites need the identical stack and drifting copies would hide differences.
 */
export async function startAuthApp(): Promise<AuthTestContext> {
  const pg: StartedPostgreSqlContainer = await startDatabase();
  const redis: StartedRedisContainer = await new RedisContainer('redis:7-alpine').start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  process.env.REDIS_URL = redis.getConnectionUrl();
  applyTestConfigDefaults();

  const patreon = new FakePatreonClient();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PATREON_CLIENT)
    .useValue(patreon)
    .compile();

  const app = moduleRef.createNestApplication();
  // Mirrors main.ts: without these the suite would pass against a request pipeline the
  // production app does not actually have.
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.setGlobalPrefix('api/v1', {
    exclude: ['healthz', 'readyz', 'auth/patreon/login', 'auth/patreon/callback', 'auth/logout'],
  });
  await app.init();

  const prisma = new PrismaClient({ datasources: { db: { url: pg.getConnectionUri() } } });
  await prisma.$connect();

  return {
    app,
    prisma,
    patreon,
    teardown: async () => {
      await prisma.$disconnect();
      await app.close();
      await pg.stop();
      await redis.stop();
    },
  };
}
