import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { PATREON_CLIENT } from '../../src/patreon/patreon.client';
import { startDatabase } from './database';
import { FakePatreonClient } from './fake-patreon.client';
import { applyTestConfigDefaults } from './env';

/**
 * Picks a cookie by name. Indexing into set-cookie assumes an ordering nothing guarantees —
 * once the CSRF middleware started setting its own cookie first, every such assumption broke.
 */
export function pickCookie(res: { headers: Record<string, unknown> }, name: string): string {
  const cookies = (res.headers['set-cookie'] as string[] | undefined) ?? [];
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (!found) throw new Error(`Expected a ${name} cookie in the response`);
  return found;
}

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

  const app = moduleRef.createNestApplication({ rawBody: true });
  // The same function main.ts calls, so the suites cannot drift onto a pipeline production
  // does not have.
  configureApp(app);
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
