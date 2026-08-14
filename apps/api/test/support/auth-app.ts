import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { PATREON_CLIENT } from '../../src/patreon/patreon.client';
import { redisUrl, startDatabase } from './database';
import { CATALOG_PROVIDER } from '../../src/catalog/catalog.provider';
import { AVAILABILITY_PROVIDER } from '../../src/availability/availability.provider';
import { AvailabilityService } from '../../src/availability/availability.service';
import { RedisService } from '../../src/redis/redis.service';
import { LimitsHarness } from './limits';
import { EMBEDDING_PROVIDER } from '../../src/embeddings/embedding.provider';
import { FakeAvailabilityProvider } from './fake-availability.provider';
import { FakeEmbeddingProvider } from './fake-embedding.provider';
import { FakeCatalogProvider } from './fake-catalog.provider';
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
  catalog: FakeCatalogProvider;
  availability: FakeAvailabilityProvider;
  embeddings: FakeEmbeddingProvider;
  /** For awaiting the background refreshes a board read queues. */
  availabilityService: AvailabilityService;
  limits: LimitsHarness;
  teardown: () => Promise<void>;
}

/**
 * Boots the real AppModule against throwaway Postgres and Redis with only the Patreon client
 * faked, so the auth suites exercise genuine routing, guards, cookies and persistence. Shared
 * because three suites need the identical stack and drifting copies would hide differences.
 */
export async function startAuthApp(): Promise<AuthTestContext> {
  const pg = await startDatabase();
  process.env.DATABASE_URL = pg.getConnectionUri();
  // One Redis for the whole run, flushed at suite start. Sharing it relies on suites running
  // sequentially, which the test script pins with --runInBand; flushing at the start rather than
  // at teardown means a crashed suite cannot leave keys for the next one.
  process.env.REDIS_URL = redisUrl();
  const flusher = new Redis(redisUrl());
  await flusher.flushall();
  await flusher.quit();
  applyTestConfigDefaults();

  const patreon = new FakePatreonClient();
  const catalog = new FakeCatalogProvider();
  const availability = new FakeAvailabilityProvider();
  const embeddings = new FakeEmbeddingProvider();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PATREON_CLIENT)
    .useValue(patreon)
    .overrideProvider(CATALOG_PROVIDER)
    .useValue(catalog)
    .overrideProvider(AVAILABILITY_PROVIDER)
    .useValue(availability)
    .overrideProvider(EMBEDDING_PROVIDER)
    .useValue(embeddings)
    .compile();

  const app = moduleRef.createNestApplication({ rawBody: true });
  // The same function main.ts calls, so the suites cannot drift onto a pipeline production
  // does not have.
  configureApp(app);
  await app.init();
  // Listening once per suite, not per request. Supertest binds an ephemeral port and closes it
  // for *every* request against a non-listening server — thousands of sockets into TIME_WAIT
  // across a run, which is a textbook source of the rare "Parse Error: Expected HTTP/" this
  // suite could produce under load. With the server already listening, supertest reuses it.
  await app.listen(0);

  const prisma = new PrismaClient({ datasources: { db: { url: pg.getConnectionUri() } } });
  await prisma.$connect();

  return {
    app,
    prisma,
    patreon,
    catalog,
    availability,
    embeddings,
    availabilityService: app.get(AvailabilityService),
    limits: new LimitsHarness(app.get(RedisService).raw()),
    teardown: async () => {
      await prisma.$disconnect();
      await app.close();
      await pg.stop();
    },
  };
}
