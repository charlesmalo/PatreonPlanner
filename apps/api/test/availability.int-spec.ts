import { randomUUID } from 'node:crypto';
import { MediaType } from '@prisma/client';
import { AvailabilityProvider } from '../src/availability/availability.provider';
import {
  AvailabilityService,
  MAX_IN_FLIGHT_REFRESHES,
} from '../src/availability/availability.service';
import { AvailabilitySnapshot } from '../src/availability/availability.types';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '../src/config/config.module';
import { startDatabase, type TestDatabase } from './support/database';
import { applyTestConfigDefaults } from './support/env';

class FakeAvailabilityProvider implements AvailabilityProvider {
  calls = 0;
  configured = true;
  throwNext = false;
  nextName = 'Netflix';
  nextSnapshot: AvailabilitySnapshot | null | undefined;

  isConfigured(): boolean {
    return this.configured;
  }

  async fetch(
    _tmdbId: number,
    _mediaType: MediaType,
    region: string,
  ): Promise<AvailabilitySnapshot | null> {
    this.calls += 1;
    if (this.throwNext) throw new Error('upstream down');
    if (this.nextSnapshot !== undefined) return this.nextSnapshot;
    return {
      region,
      link: `https://example.invalid/${region}`,
      offers: [
        {
          providerId: 8,
          providerName: this.nextName,
          logoPath: '/n.jpg',
          kind: 'FLATRATE',
          displayPriority: 1,
        },
      ],
    };
  }
}

describe('AvailabilityService (integration)', () => {
  let pg: TestDatabase;
  let prisma: PrismaClient;
  let provider: FakeAvailabilityProvider;
  let service: AvailabilityService;
  let titleId: string;
  let otherTitleId: string;

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
    service = new AvailabilityService(provider, prisma as never, new ConfigService());
    titleId = (
      await prisma.title.create({
        data: { tmdbId: 129, mediaType: 'MOVIE', name: 'Spirited Away' },
      })
    ).id;
    otherTitleId = (
      await prisma.title.create({ data: { tmdbId: 130, mediaType: 'MOVIE', name: 'Other' } })
    ).id;
  });

  const makeStale = (id: string, region: string) =>
    prisma.streamingAvailability.updateMany({
      where: { titleId: id, region },
      data: { fetchedAt: new Date(Date.now() - 1000 * 60 * 60 * 48) },
    });

  const row = (id: string, region: string) =>
    prisma.streamingAvailability.findUniqueOrThrow({
      where: { titleId_region: { titleId: id, region } },
    });

  type StoredOffer = { providerName: string };

  it('fetches and stores availability the first time it is asked', async () => {
    const stored = await service.forTitle(titleId, 'GB');
    expect(stored?.offers[0].providerName).toBe('Netflix');
    expect((await row(titleId, 'GB')).region).toBe('GB');
  });

  it('serves a fresh row without calling the provider again', async () => {
    await service.forTitle(titleId, 'GB');
    provider.calls = 0;
    await service.forTitle(titleId, 'GB');
    expect(provider.calls).toBe(0);
  });

  it('serves a stale row immediately and refreshes behind it', async () => {
    // A slow upstream must not make the board slow; a slightly old badge is worth more than a
    // blocked render.
    await service.forTitle(titleId, 'GB');
    await makeStale(titleId, 'GB');
    provider.nextName = 'Prime Video';

    const stored = await service.forTitle(titleId, 'GB');
    expect(stored?.offers[0].providerName).toBe('Netflix');

    await service.drainRefreshes();
    expect(((await row(titleId, 'GB')).offers as StoredOffer[])[0].providerName).toBe(
      'Prime Video',
    );
  });

  it('stores a row when the provider knows nothing, so the question is not re-asked', async () => {
    provider.nextSnapshot = { region: 'GB', link: null, offers: [] };
    await service.forTitle(otherTitleId, 'GB');
    expect((await row(otherTitleId, 'GB')).offers).toEqual([]);

    provider.calls = 0;
    await service.forTitle(otherTitleId, 'GB');
    expect(provider.calls).toBe(0);
  });

  it('keeps regions apart', async () => {
    await service.forTitle(titleId, 'GB');
    provider.nextName = 'Hulu';
    expect((await service.forTitle(titleId, 'US'))?.offers[0].providerName).toBe('Hulu');
    expect((await service.forTitle(titleId, 'GB'))?.offers[0].providerName).toBe('Netflix');
  });

  it('returns null rather than throwing when the provider is not configured', async () => {
    // Design §5: badges are optional garnish. A missing key must not fail a board render.
    provider.configured = false;
    expect(await service.forTitle(titleId, 'GB')).toBeNull();
    expect(provider.calls).toBe(0);
  });

  it('returns null and stores nothing when the provider errors', async () => {
    // An outage must never be cached as "available nowhere".
    provider.throwNext = true;
    expect(await service.forTitle(titleId, 'GB')).toBeNull();
    expect(await prisma.streamingAvailability.count({ where: { titleId } })).toBe(0);
  });

  it('answers with an empty snapshot for a title the provider does not know', async () => {
    provider.nextSnapshot = null;
    expect((await service.forTitle(titleId, 'GB'))?.offers).toEqual([]);
  });

  it('returns null for a title that is not in the catalogue at all', async () => {
    expect(await service.forTitle(randomUUID(), 'GB')).toBeNull();
  });

  it('reads a page of titles in one query', async () => {
    await service.forTitle(titleId, 'GB');
    await service.forTitle(otherTitleId, 'GB');
    const map = await service.forTitles([titleId, otherTitleId], 'GB');
    expect(map.size).toBe(2);
    expect(map.get(titleId)?.offers[0].providerName).toBe('Netflix');
  });

  it('never blocks a board read on the provider', async () => {
    // forTitles returns what is stored and queues the rest; a cold board renders without badges
    // rather than waiting on a third party.
    const map = await service.forTitles([titleId], 'GB');
    expect(map.size).toBe(0);
    await service.drainRefreshes();
    expect((await row(titleId, 'GB')).region).toBe('GB');
  });

  it('serves stale rows to a board read and refreshes them behind it', async () => {
    await service.forTitle(titleId, 'GB');
    await makeStale(titleId, 'GB');
    provider.nextName = 'Prime Video';

    const map = await service.forTitles([titleId], 'GB');
    expect(map.get(titleId)?.offers[0].providerName).toBe('Netflix');
    await service.drainRefreshes();
    expect(((await row(titleId, 'GB')).offers as StoredOffer[])[0].providerName).toBe(
      'Prime Video',
    );
  });

  it('returns an empty map rather than querying for no titles', async () => {
    expect((await service.forTitles([], 'GB')).size).toBe(0);
  });

  it('collapses simultaneous refreshes of the same title into one upstream call', async () => {
    // Ten patrons opening the same cold board produced ten identical in-flight fetches: the Set
    // tracked completions but nothing consulted it before starting work.
    await Promise.all(Array.from({ length: 10 }, () => service.refresh(titleId, 'GB')));
    expect(provider.calls).toBe(1);
  });

  it('does not fan a board read out to one call per reader', async () => {
    // Asserted as a bound, not as exactly one. The de-dupe collapses refreshes that are in
    // flight together; a reader whose *read* completed before the first refresh's write landed
    // sees no row and legitimately queues another. Pinning this to 1 made it a test of
    // scheduling, and it duly failed on CI's timing rather than on any behaviour.
    await Promise.all(Array.from({ length: 10 }, () => service.forTitles([titleId], 'GB')));
    await service.drainRefreshes();
    // Two, not ten: one shared refresh, plus at most one from a reader whose own read finished
    // before that refresh's write landed. Ten means the de-dupe is gone entirely.
    expect(provider.calls).toBeLessThanOrEqual(2);
  });

  it('bounds how many refreshes a single board read can start', async () => {
    const titles = await Promise.all(
      Array.from({ length: MAX_IN_FLIGHT_REFRESHES + 10 }, (_unused, i) =>
        prisma.title.create({ data: { tmdbId: 5000 + i, mediaType: 'MOVIE', name: `Bulk ${i}` } }),
      ),
    );
    await service.forTitles(
      titles.map((t) => t.id),
      'GB',
    );
    // The rest are left to the refresh job rather than fired at the upstream all at once.
    expect(provider.calls).toBeLessThanOrEqual(MAX_IN_FLIGHT_REFRESHES);
  });

  it('records a title the provider does not know, so it is not re-asked forever', async () => {
    // A row with no offers is "we asked and there is nothing"; no row at all means "never asked",
    // and every board read would queue another doomed fetch.
    provider.nextSnapshot = null;
    await service.forTitle(titleId, 'GB');
    expect((await row(titleId, 'GB')).offers).toEqual([]);

    provider.calls = 0;
    await service.forTitles([titleId], 'GB');
    await service.drainRefreshes();
    expect(provider.calls).toBe(0);
  });

  it('never asks upstream for a collection, and stores nothing for one', async () => {
    // TMDB has no watch-providers endpoint for a collection, and ids are unique only within a
    // media type — so asking anyway returns a different work's offers under the franchise's name.
    const collection = await prisma.title.create({
      data: { tmdbId: 10, mediaType: 'COLLECTION', name: 'Star Wars Collection' },
    });
    expect(await service.forTitle(collection.id, 'GB')).toBeNull();
    expect(provider.calls).toBe(0);
    expect(await prisma.streamingAvailability.count({ where: { titleId: collection.id } })).toBe(0);
  });

  it('rejects a malformed region rather than storing it', async () => {
    // The column is VARCHAR(2); a longer value would be a database error at write time, and a
    // lowercase one would silently miss every row written by the job.
    await expect(service.forTitle(titleId, 'not-a-region')).rejects.toThrow();
    await expect(service.forTitle(titleId, 'gb')).rejects.toThrow();
  });
});
