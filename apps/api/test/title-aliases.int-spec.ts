import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';
import { RelationsService } from '../src/intelligence/relations.service';

/**
 * Where a title's other-language names come from.
 *
 * `TitleAlias` had a schema, a trigram index, a join in the search query's lexical arm and a place
 * in the embedding passage — and nothing wrote a row. The feature was covered by tests that
 * created their own fixtures and inert in every running system, so a board whose patrons searched
 * in another language got nothing from it.
 */
describe('Title aliases (integration)', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await startAuthApp();
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.titleAlias.deleteMany();
    ctx.catalog.structures.clear();
  });

  const enrich = (titleId: string) => ctx.app.get(RelationsService).enrich(titleId);

  it('stores the names a title is known by elsewhere', async () => {
    const title = await ctx.prisma.title.create({
      data: { tmdbId: 5001, mediaType: 'MOVIE', name: 'Your Name' },
    });
    ctx.catalog.structures.set('5001:MOVIE', {
      collection: null,
      parts: [],
      similar: [],
      labels: [],
      aliases: [
        { language: 'ja', kind: 'NATIVE', text: '君の名は。' },
        { language: 'ja', kind: 'ROMAJI', text: 'Kimi no Na wa' },
      ],
    });

    await enrich(title.id);

    const stored = await ctx.prisma.titleAlias.findMany({
      where: { titleId: title.id },
      select: { language: true, kind: true, text: true },
      orderBy: { text: 'asc' },
    });
    expect(stored).toEqual([
      { language: 'ja', kind: 'ROMAJI', text: 'Kimi no Na wa' },
      { language: 'ja', kind: 'NATIVE', text: '君の名は。' },
    ]);
  });

  it('is idempotent, because enrichment runs again whenever a title is re-bound', async () => {
    // A title goes back into the queue every time it is suggested on another board. Duplicating
    // its aliases on each pass would grow the row set without bound and skew the trigram arm
    // toward whichever title had been suggested most often.
    const title = await ctx.prisma.title.create({
      data: { tmdbId: 5002, mediaType: 'MOVIE', name: 'Akira' },
    });
    ctx.catalog.structures.set('5002:MOVIE', {
      collection: null,
      parts: [],
      similar: [],
      labels: [],
      aliases: [{ language: 'ja', kind: 'NATIVE', text: 'アキラ' }],
    });

    await enrich(title.id);
    await enrich(title.id);

    expect(await ctx.prisma.titleAlias.count({ where: { titleId: title.id } })).toBe(1);
  });

  it('finds an entry by a name in another language, end to end', async () => {
    // The point of the feature: the lexical arm joins TitleAlias, so a patron searching in the
    // original language finds the entry without a vector anywhere near it.
    const title = await ctx.prisma.title.create({
      data: { tmdbId: 5003, mediaType: 'MOVIE', name: 'Spirited Away' },
    });
    ctx.catalog.structures.set('5003:MOVIE', {
      collection: null,
      parts: [],
      similar: [],
      labels: [],
      aliases: [{ language: 'ja', kind: 'NATIVE', text: 'Sen to Chihiro' }],
    });
    await enrich(title.id);

    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'alias-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'alias-campaign',
        ownerUserId: owner.id,
        displayName: 'Alias Co',
        slug: 'alias-co',
        policy: { create: { viewVisibility: 'PUBLIC' } },
      },
      select: { id: true },
    });
    const entry = await ctx.prisma.recommendation.create({
      data: {
        creatorId: creator.id,
        submittedByUserId: owner.id,
        type: 'MOVIE',
        titleId: title.id,
        customTitle: 'Spirited Away',
        // Required and not derived by Prisma: the search's lexical arm matches against this.
        normalizedTitle: 'spirited away',
        status: 'ACTIVE',
      },
      select: { id: true },
    });

    // Signed out, and the query shares no trigram with "Spirited Away".
    const res = await request(ctx.app.getHttpServer())
      .get('/api/v1/creators/alias-co/recommendations/similar?q=Sen%20to%20Chihiro')
      .expect(200);

    expect(res.body.items.map((i: { id: string }) => i.id)).toContain(entry.id);
    expect(pickCookie).toBeDefined();
  });
});
