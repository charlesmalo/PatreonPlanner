import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '../src/config/config.module';
import { EMBED_BATCH_SIZE, EmbedTitlesJob } from '../src/jobs/embed-titles.job';
import { startDatabase, type TestDatabase } from './support/database';
import { applyTestConfigDefaults } from './support/env';
import { FakeEmbeddingProvider } from './support/fake-embedding.provider';
import { embeddingSignature } from '../src/embeddings/passage';

describe('Title embedding job (integration)', () => {
  let pg: TestDatabase;
  let prisma: PrismaClient;
  let embeddings: FakeEmbeddingProvider;
  let job: EmbedTitlesJob;

  beforeAll(async () => {
    pg = await startDatabase();
    prisma = new PrismaClient({ datasources: { db: { url: pg.getConnectionUri() } } });
    await prisma.$connect();
    process.env.DATABASE_URL = pg.getConnectionUri();
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.EMBEDDINGS_ENABLED = 'true';
    applyTestConfigDefaults();
  }, 240_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await pg.stop();
  });

  beforeEach(async () => {
    await prisma.titleAlias.deleteMany();
    await prisma.title.deleteMany();
    embeddings = new FakeEmbeddingProvider();
    job = new EmbedTitlesJob(embeddings, prisma as never, new ConfigService());
  });

  let counter = 0;
  const makeTitle = (name = 'A Film', aliases: string[] = []) => {
    counter += 1;
    return prisma.title.create({
      data: {
        tmdbId: 5000 + counter,
        mediaType: 'MOVIE',
        name,
        aliases: {
          create: aliases.map((text) => ({ language: 'en', kind: 'OFFICIAL', text })),
        },
      },
    });
  };

  const stored = async (id: string) =>
    (
      await prisma.$queryRaw<Array<{ model: string | null; dims: number | null }>>`
        SELECT "embeddingModel" AS model,
               CASE WHEN "embedding" IS NULL THEN NULL
                    ELSE vector_dims("embedding") END AS dims
        FROM "Title" WHERE "id" = ${id}::uuid
      `
    )[0];

  it('embeds a title that has never been embedded', async () => {
    const title = await makeTitle();
    expect(await job.runOnce()).toBe(1);
    // The signature, not the bare model id: the column has to record which *recipe* produced the
    // vector as well as which model, or a recipe change leaves two spaces mixed in one column.
    expect(await stored(title.id)).toEqual({
      model: embeddingSignature('fake/model'),
      dims: 384,
    });
  });

  it('re-embeds a title whose model no longer matches the configured one', async () => {
    // A rotation must be a re-embed, not two incomparable vector spaces in one column.
    const title = await makeTitle();
    await job.runOnce();
    await prisma.title.update({ where: { id: title.id }, data: { embeddingModel: 'old/model' } });

    expect(await job.runOnce()).toBe(1);
    expect((await stored(title.id)).model).toBe(embeddingSignature('fake/model'));
  });

  it('leaves an up-to-date title alone', async () => {
    await makeTitle();
    await job.runOnce();
    embeddings.calls = 0;
    expect(await job.runOnce()).toBe(0);
    expect(embeddings.calls).toBe(0);
  });

  it('embeds the aliases alongside the name', async () => {
    // The aliases carry the other-language surface forms; the name alone throws away the one
    // piece of cross-language signal already stored.
    const withAlias = await makeTitle('君の名は。', ['Your Name']);
    const without = await makeTitle('君の名は。');
    await job.runOnce();

    const vectors = await prisma.$queryRaw<Array<{ id: string; v: string }>>`
      SELECT "id", "embedding"::text AS v FROM "Title" ORDER BY "createdAt"
    `;
    const byId = new Map(vectors.map((row) => [row.id, row.v]));
    expect(byId.get(withAlias.id)).not.toBe(byId.get(without.id));
  });

  it('stops at the batch size', async () => {
    for (let i = 0; i < EMBED_BATCH_SIZE + 5; i += 1) await makeTitle();
    expect(await job.runOnce()).toBe(EMBED_BATCH_SIZE);
  });

  it('does nothing when embeddings are disabled', async () => {
    await makeTitle();
    embeddings.configured = false;
    expect(await job.runOnce()).toBe(0);
    expect(embeddings.calls).toBe(0);
  });

  it('leaves the batch retryable when inference fails', async () => {
    // The rows keep a null model and come round again rather than being marked done.
    const title = await makeTitle('Doomed');
    embeddings.failOn = 'Doomed';
    expect(await job.runOnce()).toBe(0);
    expect((await stored(title.id)).model).toBeNull();

    embeddings.failOn = undefined;
    expect(await job.runOnce()).toBe(1);
  });

  it('refuses a vector of the wrong width, and says which two disagree', async () => {
    // Swapping EMBEDDING_MODEL for one of a different width is the realistic way here, and what
    // it produced was a batch of identical warnings naming a uuid and a Postgres error — every
    // tick, forever — while the product symptom was silence: no vectors, so the semantic arm
    // returns nothing and search quietly degrades to spelling alone. That exact silence has cost
    // this project a five-layer investigation once already.
    //
    // EMBEDDING_DIMENSIONS exists to state the column's width and was read by nothing that runs.
    // It is the contract, so it is what the model is checked against.
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const titles = await Promise.all([makeTitle('One'), makeTitle('Two'), makeTitle('Three')]);
      embeddings.embedPassages = async (texts: string[]) =>
        texts.map(() => new Array(768).fill(0.1));

      expect(await job.runOnce()).toBe(0);

      // The safety property first: a column of the wrong width is never written, and the rows
      // keep a null model so they come round again once the mismatch is resolved.
      for (const title of titles) expect((await stored(title.id)).model).toBeNull();

      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toMatch(/768.*384|384.*768/);
      // Not one per row: the batch stops before the writes rather than failing each of them.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
