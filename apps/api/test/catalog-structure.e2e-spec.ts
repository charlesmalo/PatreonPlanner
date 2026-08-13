import { ConfigService } from '../src/config/config.module';
import { SIMILAR_CAP, TmdbCatalogProvider } from '../src/catalog/tmdb-catalog.provider';
import { applyTestConfigDefaults } from './support/env';

describe('TmdbCatalogProvider structure', () => {
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

  /** Routes by longest matching path so `/movie/129` and `/movie/129/similar` stay distinct. */
  function stubRoutes(routes: Record<string, { status?: number; body?: unknown }>) {
    global.fetch = jest.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname.replace(/^\/3/, '');
      const match = Object.keys(routes)
        .filter((key) => path === key)
        .sort((a, b) => b.length - a.length)[0];
      const route = match ? routes[match] : { status: 404 };
      const status = route.status ?? 200;
      return { ok: status < 400, status, json: async () => route.body ?? {} };
    }) as never;
  }

  it('reads a film collection membership, labels and similar titles', async () => {
    stubRoutes({
      '/movie/129': {
        body: {
          id: 129,
          belongs_to_collection: { id: 10, name: 'Ghibli Collection' },
          genres: [{ name: 'Animation' }, { name: 'Fantasy' }],
        },
      },
      '/movie/129/keywords': { body: { keywords: [{ name: 'anime' }] } },
      '/movie/129/similar': { body: { results: [{ id: 8392 }] } },
    });

    const structure = await provider.fetchStructure(129, 'MOVIE');
    expect(structure.collection).toEqual({ tmdbId: 10, name: 'Ghibli Collection' });
    expect(structure.labels).toEqual(['Animation', 'Fantasy', 'anime']);
    expect(structure.similar).toEqual([{ tmdbId: 8392, mediaType: 'MOVIE' }]);
    expect(structure.parts).toEqual([]);
  });

  it('reads a collection parts in TMDB order', async () => {
    stubRoutes({ '/collection/10': { body: { id: 10, parts: [{ id: 1 }, { id: 2 }] } } });
    const structure = await provider.fetchStructure(10, 'COLLECTION');
    expect(structure.parts).toEqual([
      { tmdbId: 1, mediaType: 'MOVIE', ordinal: 0 },
      { tmdbId: 2, mediaType: 'MOVIE', ordinal: 1 },
    ]);
    // A collection has no collection of its own and no similar list.
    expect(structure.collection).toBeNull();
    expect(structure.similar).toEqual([]);
  });

  it('uses the tv keyword shape, which differs from a film', async () => {
    // TMDB returns `keywords` for a film and `results` for a series, under the same path.
    stubRoutes({
      '/tv/1': { body: { id: 1, genres: [] } },
      '/tv/1/keywords': { body: { results: [{ name: 'k-drama' }] } },
      '/tv/1/similar': { body: { results: [] } },
    });
    const structure = await provider.fetchStructure(1, 'TV');
    expect(structure.labels).toEqual(['k-drama']);
    expect(structure.similar).toEqual([]);
  });

  it('marks similar titles with the right media type', async () => {
    stubRoutes({
      '/tv/1': { body: { id: 1, genres: [] } },
      '/tv/1/keywords': { body: { results: [] } },
      '/tv/1/similar': { body: { results: [{ id: 55 }] } },
    });
    expect((await provider.fetchStructure(1, 'TV')).similar).toEqual([
      { tmdbId: 55, mediaType: 'TV' },
    ]);
  });

  it('caps similar titles', async () => {
    stubRoutes({
      '/movie/129': { body: { id: 129, genres: [] } },
      '/movie/129/keywords': { body: { keywords: [] } },
      '/movie/129/similar': {
        body: { results: Array.from({ length: 40 }, (_unused, i) => ({ id: i + 1 })) },
      },
    });
    expect((await provider.fetchStructure(129, 'MOVIE')).similar).toHaveLength(SIMILAR_CAP);
  });

  it('degrades to an empty part of the structure when one sub-call fails', async () => {
    // Relations are garnish. One failing endpoint must not deny the title its collection.
    stubRoutes({
      '/movie/129': {
        body: {
          id: 129,
          belongs_to_collection: { id: 10, name: 'C' },
          genres: [{ name: 'Anime' }],
        },
      },
      '/movie/129/keywords': { status: 500 },
      '/movie/129/similar': { status: 500 },
    });
    const structure = await provider.fetchStructure(129, 'MOVIE');
    expect(structure.collection).toEqual({ tmdbId: 10, name: 'C' });
    // Genres come from the detail call, which succeeded; only the keywords are lost.
    expect(structure.labels).toEqual(['Anime']);
    expect(structure.similar).toEqual([]);
  });

  it('throws when the title itself cannot be read', async () => {
    stubRoutes({ '/movie/129': { status: 500 } });
    await expect(provider.fetchStructure(129, 'MOVIE')).rejects.toThrow();
  });

  it('de-duplicates labels differing only in case', async () => {
    stubRoutes({
      '/movie/129': { body: { id: 129, genres: [{ name: 'Anime' }] } },
      '/movie/129/keywords': { body: { keywords: [{ name: 'anime' }] } },
      '/movie/129/similar': { body: { results: [] } },
    });
    expect((await provider.fetchStructure(129, 'MOVIE')).labels).toEqual(['Anime']);
  });
});
