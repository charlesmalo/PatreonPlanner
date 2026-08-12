import { PrismaClient } from '@prisma/client';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AvailabilityService } from '../src/availability/availability.service';
import { ConfigService } from '../src/config/config.module';
import {
  AVAILABILITY_BATCH_SIZE,
  AvailabilityRefreshJob,
} from '../src/jobs/availability-refresh.job';
import { startDatabase } from './support/database';
import { applyTestConfigDefaults } from './support/env';
import { FakeAvailabilityProvider } from './support/fake-availability.provider';

describe('AvailabilityRefreshJob (integration)', () => {
  let pg: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let provider: FakeAvailabilityProvider;
  let job: AvailabilityRefreshJob;

  beforeAll(async () => {
    pg = await startDatabase();
    prisma = new PrismaClient({ datasources: { db: { url: pg.getConnectionUri() } } });
    await prisma.$connect();
    process.env.DATABASE_URL = pg.getConnectionUri();
    process.env.REDIS_URL = 'redis://localhost:6379';
    applyTestConfigDefaults();
  }, 240_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await pg.stop();
  });

  beforeEach(async () => {
    await prisma.streamingAvailability.deleteMany();
    await prisma.title.deleteMany();
    provider = new FakeAvailabilityProvider();
    const config = new ConfigService();
    const service = new AvailabilityService(provider, prisma as never, config);
    job = new AvailabilityRefreshJob(service, prisma as never, config);
  });

  const STALE_AT = new Date(Date.now() - 1000 * 60 * 60 * 48);

  async function seedRows(count: number, opts: { stale: boolean }) {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const title = await prisma.title.create({
        data: { tmdbId: 1000 + i, mediaType: 'MOVIE', name: `Title ${i}` },
      });
      const row = await prisma.streamingAvailability.create({
        data: {
          titleId: title.id,
          region: 'GB',
          link: null,
          offers: [],
          fetchedAt: opts.stale ? new Date(STALE_AT.getTime() + i * 1000) : new Date(),
        },
      });
      ids.push(row.id);
    }
    return ids;
  }

  it('refreshes the oldest rows first and stops at the batch size', async () => {
    // Plan 04's staleness job shipped without a SQL LIMIT and read the whole table. This asserts
    // this one has one.
    await seedRows(AVAILABILITY_BATCH_SIZE + 5, { stale: true });
    await job.runOnce();
    expect(provider.calls).toBe(AVAILABILITY_BATCH_SIZE);
  });

  it('leaves fresh rows alone', async () => {
    await seedRows(3, { stale: false });
    await job.runOnce();
    expect(provider.calls).toBe(0);
  });

  it('moves fetchedAt forward even when the answer did not change', async () => {
    // Otherwise an unchanging title is retried on every pass and starves everything behind it.
    const [id] = await seedRows(1, { stale: true });
    const before = await prisma.streamingAvailability.findUniqueOrThrow({ where: { id } });
    await job.runOnce();
    const after = await prisma.streamingAvailability.findUniqueOrThrow({ where: { id } });
    expect(after.fetchedAt.getTime()).toBeGreaterThan(before.fetchedAt.getTime());
  });

  it('stamps fetchedAt even when the lookup fails', async () => {
    // A permanently failing title must rotate to the back of the queue rather than occupying the
    // batch on every tick forever — the exact failure Plan 04 had to be fixed for.
    const [id] = await seedRows(1, { stale: true });
    provider.throwNext = true;
    await job.runOnce();
    const after = await prisma.streamingAvailability.findUniqueOrThrow({ where: { id } });
    expect(after.fetchedAt.getTime()).toBeGreaterThan(STALE_AT.getTime());
  });

  it('keeps going when one title fails', async () => {
    await seedRows(3, { stale: true });
    let call = 0;
    const original = provider.fetch.bind(provider);
    provider.fetch = async (...args) => {
      call += 1;
      if (call === 2) throw new Error('one bad title');
      return original(...args);
    };
    expect(await job.runOnce()).toBe(2);
    expect(call).toBe(3);
  });

  it('does nothing when the provider is not configured', async () => {
    await seedRows(3, { stale: true });
    provider.configured = false;
    await job.runOnce();
    expect(provider.calls).toBe(0);
  });

  it('refreshes each region of a title independently', async () => {
    const title = await prisma.title.create({
      data: { tmdbId: 9999, mediaType: 'MOVIE', name: 'Multi-region' },
    });
    for (const region of ['GB', 'US']) {
      await prisma.streamingAvailability.create({
        data: { titleId: title.id, region, link: null, offers: [], fetchedAt: STALE_AT },
      });
    }
    await job.runOnce();
    expect(provider.calls).toBe(2);
  });
});
