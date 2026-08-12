import { ConfigService } from '../src/config/config.module';
import { TmdbCatalogProvider } from '../src/catalog/tmdb-catalog.provider';
import { applyTestConfigDefaults } from './support/env';

describe('TmdbCatalogProvider collections', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.TMDB_API_KEY;
  let provider: TmdbCatalogProvider;

  beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
    process.env.REDIS_URL = 'redis://localhost:6379';
    applyTestConfigDefaults();
    process.env.TMDB_API_KEY = 'test-key';
    provider = new TmdbCatalogProvider(new ConfigService());
  });

  afterAll(() => {
    global.fetch = originalFetch;
    process.env.TMDB_API_KEY = originalKey;
  });

  /** Routes by path so the two search calls can answer differently. */
  function stubRoutes(routes: Record<string, { status?: number; body?: unknown }>) {
    global.fetch = jest.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      const match = Object.keys(routes).find((key) => path.includes(key));
      const route = match ? routes[match] : { status: 404 };
      const status = route.status ?? 200;
      return { ok: status < 400, status, json: async () => route.body ?? {} };
    }) as never;
  }

  const MOVIE_RESULT = {
    id: 129,
    media_type: 'movie',
    title: 'Spirited Away',
    release_date: '2001-07-20',
  };

  it('fetches a TMDB collection as a title', async () => {
    stubRoutes({
      '/collection/10': {
        body: {
          id: 10,
          name: 'Star Wars Collection',
          overview: 'A galaxy…',
          poster_path: '/sw.jpg',
        },
      },
    });
    expect(await provider.fetchTitle(10, 'COLLECTION')).toEqual({
      tmdbId: 10,
      mediaType: 'COLLECTION',
      name: 'Star Wars Collection',
      // A collection has no single release date, and inventing one from its parts is a guess.
      year: null,
      posterPath: '/sw.jpg',
      overview: 'A galaxy…',
    });
  });

  it('returns null for a collection TMDB does not know', async () => {
    stubRoutes({ '/collection/999': { status: 404 } });
    expect(await provider.fetchTitle(999, 'COLLECTION')).toBeNull();
  });

  it('includes collections in search results', async () => {
    // TMDB's search/multi does not return collections; they need their own call.
    stubRoutes({
      '/search/multi': { body: { results: [MOVIE_RESULT] } },
      '/search/collection': { body: { results: [{ id: 10, name: 'Star Wars Collection' }] } },
    });
    const results = await provider.search('star wars');
    expect(results.map((r) => r.mediaType)).toEqual(
      expect.arrayContaining(['MOVIE', 'COLLECTION']),
    );
    expect(results.find((r) => r.mediaType === 'COLLECTION')?.name).toBe('Star Wars Collection');
  });

  it('still returns film results when the collection search fails', async () => {
    // Two upstream calls now; one failing must degrade the autocomplete, not empty it.
    stubRoutes({
      '/search/multi': { body: { results: [MOVIE_RESULT] } },
      '/search/collection': { status: 500 },
    });
    const results = await provider.search('star wars');
    expect(results).toHaveLength(1);
    expect(results[0].mediaType).toBe('MOVIE');
  });

  it('still returns collections when the multi search fails', async () => {
    stubRoutes({
      '/search/multi': { status: 500 },
      '/search/collection': { body: { results: [{ id: 10, name: 'Star Wars Collection' }] } },
    });
    const results = await provider.search('star wars');
    expect(results).toHaveLength(1);
    expect(results[0].mediaType).toBe('COLLECTION');
  });

  it('throws when both searches fail rather than reporting no matches', async () => {
    // "Nothing found" and "we could not ask" are different answers, and the second must not be
    // rendered as an empty autocomplete.
    stubRoutes({ '/search/multi': { status: 500 }, '/search/collection': { status: 500 } });
    await expect(provider.search('star wars')).rejects.toThrow();
  });
});

describe('TmdbCatalogProvider error handling', () => {
  const originalFetch = global.fetch;
  let provider: TmdbCatalogProvider;

  beforeAll(() => {
    process.env.TMDB_API_KEY = 'test-key';
    provider = new TmdbCatalogProvider(new ConfigService());
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('distinguishes an unknown title from an upstream failure', async () => {
    // Both used to return null, so a 429 during a fifty-step watch order told the patron their
    // submission contained an "Unknown title".
    global.fetch = jest.fn(async () => ({ ok: false, status: 404 })) as never;
    expect(await provider.fetchTitle(1, 'MOVIE')).toBeNull();

    global.fetch = jest.fn(async () => ({ ok: false, status: 429 })) as never;
    await expect(provider.fetchTitle(1, 'MOVIE')).rejects.toThrow();
  });
});
