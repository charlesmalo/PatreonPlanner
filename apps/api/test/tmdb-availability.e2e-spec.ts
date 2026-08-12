import { Logger } from '@nestjs/common';
import { ConfigService } from '../src/config/config.module';
import { TmdbAvailabilityProvider } from '../src/availability/tmdb-availability.provider';
import { applyTestConfigDefaults } from './support/env';

describe('TmdbAvailabilityProvider', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.TMDB_API_KEY;
  let provider: TmdbAvailabilityProvider;

  beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
    process.env.REDIS_URL = 'redis://localhost:6379';
    applyTestConfigDefaults();
    process.env.TMDB_API_KEY = 'test-key';
    provider = new TmdbAvailabilityProvider(new ConfigService());
  });

  afterAll(() => {
    global.fetch = originalFetch;
    process.env.TMDB_API_KEY = originalKey;
  });

  const stubJson = (body: unknown) =>
    (global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => body,
    })) as never);

  const stubStatus = (status: number) =>
    (global.fetch = jest.fn(async () => ({ ok: false, status })) as never);

  it('maps TMDB watch providers for the requested region', async () => {
    stubJson({
      id: 129,
      results: {
        GB: {
          link: 'https://www.themoviedb.org/movie/129/watch?locale=GB',
          flatrate: [
            { provider_id: 8, provider_name: 'Netflix', logo_path: '/n.jpg', display_priority: 1 },
          ],
          rent: [
            {
              provider_id: 3,
              provider_name: 'Google Play',
              logo_path: '/g.jpg',
              display_priority: 5,
            },
          ],
        },
        US: { link: 'https://example.invalid/us', flatrate: [] },
      },
    });

    const snapshot = await provider.fetch(129, 'MOVIE', 'GB');
    expect(snapshot?.offers).toEqual([
      {
        providerId: 8,
        providerName: 'Netflix',
        logoPath: '/n.jpg',
        kind: 'FLATRATE',
        displayPriority: 1,
      },
      {
        providerId: 3,
        providerName: 'Google Play',
        logoPath: '/g.jpg',
        kind: 'RENT',
        displayPriority: 5,
      },
    ]);
    expect(snapshot?.link).toBe('https://www.themoviedb.org/movie/129/watch?locale=GB');
  });

  it('orders the cheapest way to watch first', async () => {
    stubJson({
      id: 1,
      results: {
        GB: {
          buy: [{ provider_id: 3, provider_name: 'Buy', logo_path: null, display_priority: 1 }],
          flatrate: [
            { provider_id: 8, provider_name: 'Sub', logo_path: null, display_priority: 9 },
          ],
          free: [{ provider_id: 9, provider_name: 'Free', logo_path: null, display_priority: 9 }],
        },
      },
    });
    const snapshot = await provider.fetch(1, 'MOVIE', 'GB');
    expect(snapshot?.offers.map((o) => o.kind)).toEqual(['FLATRATE', 'FREE', 'BUY']);
  });

  it('returns an empty snapshot rather than null when the region is absent', async () => {
    // "TMDB knows nothing here" is a real answer and must be cacheable; null would mean "we never
    // asked" and the refresh job would re-ask forever.
    stubJson({ id: 129, results: { US: { link: 'x', flatrate: [] } } });
    expect(await provider.fetch(129, 'MOVIE', 'GB')).toEqual({
      region: 'GB',
      link: null,
      offers: [],
    });
  });

  it('returns null for a title TMDB does not know', async () => {
    // A 404 is a client mistake; anything else is trouble and must not be cached as "nowhere".
    stubStatus(404);
    expect(await provider.fetch(999, 'MOVIE', 'GB')).toBeNull();
  });

  it('throws on an upstream error rather than reporting no availability', async () => {
    stubStatus(500);
    await expect(provider.fetch(1, 'MOVIE', 'GB')).rejects.toThrow();
  });

  it('never logs the response body', async () => {
    // The body can echo the key on some TMDB errors, exactly as the catalogue provider documents.
    stubStatus(401);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(provider.fetch(1, 'MOVIE', 'GB')).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith('TMDB availability request failed with status 401');
    warn.mockRestore();
  });

  it('uses the tv path for a series', async () => {
    const calls: string[] = [];
    global.fetch = jest.fn(async (url: unknown) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ id: 1, results: {} }) };
    }) as never;
    await provider.fetch(1, 'TV', 'GB');
    expect(calls[0]).toContain('/tv/1/watch/providers');
  });

  it('reports not configured without an API key', () => {
    // Absent, not empty: the config schema rejects an empty string outright, so "" is a
    // misconfiguration rather than the unconfigured case this asserts.
    const previous = process.env.TMDB_API_KEY;
    delete process.env.TMDB_API_KEY;
    expect(new TmdbAvailabilityProvider(new ConfigService()).isConfigured()).toBe(false);
    process.env.TMDB_API_KEY = previous;
  });
});
