import { PrismaClient } from '@prisma/client';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ConfigService } from '../src/config/config.module';
import { RelationsService } from '../src/intelligence/relations.service';
import { ThemesService } from '../src/intelligence/themes.service';
import { ENRICH_BATCH_SIZE, EnrichTitleJob } from '../src/jobs/enrich-title.job';
import { startDatabase } from './support/database';
import { applyTestConfigDefaults } from './support/env';
import { FakeCatalogProvider } from './support/fake-catalog.provider';

describe('Relation and theme enrichment (integration)', () => {
  let pg: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let catalog: FakeCatalogProvider;
  let relations: RelationsService;
  let themes: ThemesService;
  let job: EnrichTitleJob;
  let creatorId: string;

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
    await prisma.titleRelation.deleteMany();
    await prisma.titleTheme.deleteMany();
    await prisma.theme.deleteMany();
    await prisma.title.deleteMany();
    await prisma.creator.deleteMany();
    await prisma.user.deleteMany();

    catalog = new FakeCatalogProvider();
    themes = new ThemesService(prisma as never);
    relations = new RelationsService(catalog, prisma as never, themes);
    job = new EnrichTitleJob(relations, catalog, prisma as never);

    const owner = await prisma.user.create({ data: { patreonUserId: 'en-owner' } });
    creatorId = (
      await prisma.creator.create({
        data: {
          patreonCampaignId: 'en-campaign',
          ownerUserId: owner.id,
          displayName: 'Enrich Co',
          slug: 'enrich-co',
        },
      })
    ).id;
  });

  const makeTitle = (tmdbId: number, mediaType: 'MOVIE' | 'TV' | 'COLLECTION', name = 'T') =>
    prisma.title.create({ data: { tmdbId, mediaType, name } });

  describe('relations', () => {
    it('records a film as a member of its collection, creating the collection title', async () => {
      const film = await makeTitle(129, 'MOVIE', 'Spirited Away');
      catalog.structures.set('129:MOVIE', {
        collection: { tmdbId: 10, name: 'Ghibli Collection' },
        parts: [],
        similar: [],
        labels: [],
      });

      await relations.enrich(film.id);

      const relation = await prisma.titleRelation.findFirstOrThrow({ where: { fromId: film.id } });
      expect(relation.kind).toBe('SAME_FRANCHISE');
      const collection = await prisma.title.findUniqueOrThrow({ where: { id: relation.toId } });
      expect(collection.mediaType).toBe('COLLECTION');
      expect(collection.name).toBe('Ghibli Collection');
    });

    it('records collection parts pointing at the collection, in order', async () => {
      const collection = await makeTitle(10, 'COLLECTION', 'Ghibli Collection');
      const first = await makeTitle(1, 'MOVIE');
      const second = await makeTitle(2, 'MOVIE');
      catalog.structures.set('10:COLLECTION', {
        collection: null,
        parts: [
          { tmdbId: 1, mediaType: 'MOVIE', ordinal: 0 },
          { tmdbId: 2, mediaType: 'MOVIE', ordinal: 1 },
        ],
        similar: [],
        labels: [],
      });

      await relations.enrich(collection.id);

      const rows = await prisma.titleRelation.findMany({
        where: { toId: collection.id },
        orderBy: { ordinal: 'asc' },
      });
      // Direction is member → container, so nesting can never put the collection under a part.
      expect(rows.map((r) => r.fromId)).toEqual([first.id, second.id]);
      expect(rows.map((r) => r.ordinal)).toEqual([0, 1]);
    });

    it('does not invent a title for a collection part it has never seen', async () => {
      // A part nobody has submitted is not worth a catalogue row; it becomes one when someone
      // suggests it.
      const collection = await makeTitle(10, 'COLLECTION');
      catalog.structures.set('10:COLLECTION', {
        collection: null,
        parts: [{ tmdbId: 999, mediaType: 'MOVIE', ordinal: 0 }],
        similar: [],
        labels: [],
      });
      await relations.enrich(collection.id);
      expect(await prisma.titleRelation.count()).toBe(0);
      expect(await prisma.title.count()).toBe(1);
    });

    it('records similar titles as RELATED when both are known', async () => {
      const film = await makeTitle(129, 'MOVIE');
      const other = await makeTitle(8392, 'MOVIE');
      catalog.structures.set('129:MOVIE', {
        collection: null,
        parts: [],
        similar: [{ tmdbId: 8392, mediaType: 'MOVIE' }],
        labels: [],
      });
      await relations.enrich(film.id);
      const relation = await prisma.titleRelation.findFirstOrThrow({ where: { fromId: film.id } });
      expect(relation).toMatchObject({ kind: 'RELATED', toId: other.id });
    });

    it('is idempotent', async () => {
      const film = await makeTitle(129, 'MOVIE');
      catalog.structures.set('129:MOVIE', {
        collection: { tmdbId: 10, name: 'C' },
        parts: [],
        similar: [],
        labels: [],
      });
      await relations.enrich(film.id);
      await relations.enrich(film.id);
      expect(await prisma.titleRelation.count({ where: { fromId: film.id } })).toBe(1);
    });

    it('never relates a title to itself', async () => {
      // TMDB's similar list can include the subject; a self-relation nests an entry under itself.
      const film = await makeTitle(129, 'MOVIE');
      catalog.structures.set('129:MOVIE', {
        collection: null,
        parts: [],
        similar: [{ tmdbId: 129, mediaType: 'MOVIE' }],
        labels: [],
      });
      await relations.enrich(film.id);
      expect(await prisma.titleRelation.count()).toBe(0);
    });
  });

  describe('themes', () => {
    it('seeds a theme per label, scoped to the creator', async () => {
      const film = await makeTitle(129, 'MOVIE');
      await themes.seedFor(film.id, creatorId, ['Animation', 'anime']);
      const rows = await prisma.theme.findMany({ where: { creatorId } });
      expect(rows.map((t) => t.name).sort()).toEqual(['Animation', 'anime']);
      expect(await prisma.titleTheme.count({ where: { titleId: film.id } })).toBe(2);
    });

    it('treats labels differing only in case as one theme', async () => {
      const film = await makeTitle(129, 'MOVIE');
      await themes.seedFor(film.id, creatorId, ['Anime', 'anime']);
      expect(await prisma.theme.count({ where: { creatorId } })).toBe(1);
    });

    it('does not resurrect a theme the creator renamed', async () => {
      // Re-seeding matches the TMDB label, not the display name — otherwise curation is undone
      // every time another title with the same genre lands on the board.
      const film = await makeTitle(129, 'MOVIE');
      const other = await makeTitle(8392, 'MOVIE');
      await themes.seedFor(film.id, creatorId, ['Animation']);
      await prisma.theme.updateMany({
        where: { creatorId },
        data: { name: 'Cartoons', slug: 'cartoons' },
      });

      await themes.seedFor(other.id, creatorId, ['Animation']);
      const rows = await prisma.theme.findMany({ where: { creatorId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Cartoons');
    });

    it('keeps two creators themes apart', async () => {
      const owner = await prisma.user.findFirstOrThrow();
      const other = await prisma.creator.create({
        data: {
          patreonCampaignId: 'en-other',
          ownerUserId: owner.id,
          displayName: 'Other',
          slug: 'en-other',
        },
      });
      const film = await makeTitle(129, 'MOVIE');
      await themes.seedFor(film.id, creatorId, ['Animation']);
      await themes.seedFor(film.id, other.id, ['Animation']);
      expect(await prisma.theme.count()).toBe(2);
    });

    it('is idempotent', async () => {
      const film = await makeTitle(129, 'MOVIE');
      await themes.seedFor(film.id, creatorId, ['Animation']);
      await themes.seedFor(film.id, creatorId, ['Animation']);
      expect(await prisma.titleTheme.count()).toBe(1);
    });

    it('attaches to an existing theme when a rename freed its label', async () => {
      // The creator renames "Animation" to "Anime". Later a title carrying the TMDB keyword
      // "anime" is seeded: no row matches on sourceKey, so the insert collides on the *slug*
      // index — a P2002 that aborted the whole title, for every creator after it in the loop,
      // permanently, because enrichedAt is stamped regardless.
      const film = await makeTitle(129, 'MOVIE');
      const other = await makeTitle(8392, 'MOVIE');
      await themes.seedFor(film.id, creatorId, ['Animation']);
      await prisma.theme.updateMany({
        where: { creatorId },
        data: { name: 'Anime', slug: 'anime' },
      });

      await expect(themes.seedFor(other.id, creatorId, ['anime'])).resolves.toBeUndefined();
      expect(await prisma.theme.count({ where: { creatorId } })).toBe(1);
      // And the title is attached to the theme that now owns that name.
      expect(await prisma.titleTheme.count({ where: { titleId: other.id } })).toBe(1);
    });
  });

  describe('enrichment end to end', () => {
    // The relations tests above never create a Recommendation, so `enrich()` finds no creators
    // and never calls seedFor at all — which is exactly where both critical bugs lived.
    async function suggest(titleId: string, targetCreatorId = creatorId) {
      const user = await prisma.user.findFirstOrThrow();
      return prisma.recommendation.create({
        data: {
          creatorId: targetCreatorId,
          submittedByUserId: user.id,
          type: 'MOVIE',
          titleId,
          customTitle: `Entry ${titleId}`,
          normalizedTitle: `entry ${titleId}`,
        },
      });
    }

    /** What resolveTitle's upsert does on a re-bind, exercised through the submit suite. */
    const rebind = (titleId: string) =>
      prisma.title.update({ where: { id: titleId }, data: { enrichedAt: null } });

    it('seeds themes for the creator whose board the title is on', async () => {
      const film = await makeTitle(129, 'MOVIE');
      await suggest(film.id);
      catalog.structures.set('129:MOVIE', {
        collection: null,
        parts: [],
        similar: [],
        labels: ['Animation'],
      });

      await relations.enrich(film.id);
      expect(await prisma.theme.count({ where: { creatorId } })).toBe(1);
      expect(await prisma.titleTheme.count({ where: { titleId: film.id } })).toBe(1);
    });

    it('seeds themes for a creator who adds the title after it was already enriched', async () => {
      // A title is enriched once globally. Without clearing the stamp when it lands on a new
      // board, every creator but the first loses theme chips on that entry — forever.
      const film = await makeTitle(129, 'MOVIE');
      const owner = await prisma.user.findFirstOrThrow();
      const second = await prisma.creator.create({
        data: {
          patreonCampaignId: 'en-second',
          ownerUserId: owner.id,
          displayName: 'Second',
          slug: 'en-second',
        },
      });
      catalog.structures.set('129:MOVIE', {
        collection: null,
        parts: [],
        similar: [],
        labels: ['Animation'],
      });

      await suggest(film.id);
      await job.runOnce();
      expect(await prisma.theme.count({ where: { creatorId: second.id } })).toBe(0);

      // The second creator's patron suggests the same film. Binding it must put the title back
      // in the queue — nothing here clears the stamp by hand, which is what hid this before.
      await suggest(film.id, second.id);
      await rebind(film.id);
      await job.runOnce();
      expect(await prisma.theme.count({ where: { creatorId: second.id } })).toBe(1);
    });

    it('keeps seeding the remaining creators when one of them fails', async () => {
      const film = await makeTitle(129, 'MOVIE');
      const owner = await prisma.user.findFirstOrThrow();
      const second = await prisma.creator.create({
        data: {
          patreonCampaignId: 'en-third',
          ownerUserId: owner.id,
          displayName: 'Third',
          slug: 'en-third',
        },
      });
      await suggest(film.id);
      await suggest(film.id, second.id);
      // The first creator has renamed a theme onto the label about to be seeded.
      await themes.seedFor(film.id, creatorId, ['Animation']);
      await prisma.theme.updateMany({
        where: { creatorId },
        data: { name: 'Anime', slug: 'anime' },
      });
      catalog.structures.set('129:MOVIE', {
        collection: null,
        parts: [],
        similar: [],
        labels: ['anime'],
      });

      await relations.enrich(film.id);
      expect(await prisma.theme.count({ where: { creatorId: second.id } })).toBe(1);
    });
  });

  describe('the job', () => {
    it('stops at the batch size', async () => {
      for (let i = 0; i < ENRICH_BATCH_SIZE + 5; i += 1) await makeTitle(1000 + i, 'MOVIE');
      await job.runOnce();
      expect(catalog.structureCalls).toBe(ENRICH_BATCH_SIZE);
    });

    it('leaves already-enriched titles alone', async () => {
      const film = await makeTitle(129, 'MOVIE');
      await prisma.title.update({ where: { id: film.id }, data: { enrichedAt: new Date() } });
      await job.runOnce();
      expect(catalog.structureCalls).toBe(0);
    });

    it('stamps enrichedAt even when the lookup fails', async () => {
      // The failure Plan 04's job shipped with: an unstamped row occupies the batch forever.
      const film = await makeTitle(129, 'MOVIE');
      catalog.shouldFail = true;
      await job.runOnce();
      const after = await prisma.title.findUniqueOrThrow({ where: { id: film.id } });
      expect(after.enrichedAt).not.toBeNull();
    });

    it('keeps going when one title fails', async () => {
      await makeTitle(1, 'MOVIE');
      await makeTitle(2, 'MOVIE');
      await makeTitle(3, 'MOVIE');
      let call = 0;
      const original = catalog.fetchStructure.bind(catalog);
      catalog.fetchStructure = async (...args) => {
        call += 1;
        if (call === 2) throw new Error('one bad title');
        return original(...args);
      };
      expect(await job.runOnce()).toBe(2);
      expect(call).toBe(3);
    });

    it('does nothing without a catalogue key', async () => {
      await makeTitle(129, 'MOVIE');
      catalog.configured = false;
      await job.runOnce();
      expect(catalog.structureCalls).toBe(0);
    });
  });
});
