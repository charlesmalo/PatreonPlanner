import { PrismaClient } from '@prisma/client';
import { startDatabase, type TestDatabase } from './support/database';

describe('Recommendation models (integration)', () => {
  let pg: TestDatabase;
  let prisma: PrismaClient;
  let creatorId: string;
  let userId: string;

  beforeAll(async () => {
    pg = await startDatabase();
    prisma = new PrismaClient({ datasources: { db: { url: pg.getConnectionUri() } } });
    await prisma.$connect();
    const owner = await prisma.user.create({ data: { patreonUserId: 'rec-owner' } });
    userId = owner.id;
    const creator = await prisma.creator.create({
      data: {
        patreonCampaignId: 'rec-campaign',
        ownerUserId: owner.id,
        displayName: 'Rec Co',
        slug: 'rec-co',
      },
    });
    creatorId = creator.id;
  }, 180_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await pg.stop();
  });

  const make = (customTitle = 'A Thing') =>
    prisma.recommendation.create({
      data: {
        creatorId,
        submittedByUserId: userId,
        type: 'EXTERNAL_LINK',
        customTitle,
        normalizedTitle: customTitle.toLowerCase(),
      },
    });

  it('defaults to PENDING with no upvotes', async () => {
    const rec = await make('Defaults');
    expect(rec.status).toBe('PENDING');
    expect(rec.upvoteCount).toBe(0);
  });

  it('allows only one upvote per user per recommendation', async () => {
    const rec = await make('Once Only');
    await prisma.upvote.create({ data: { recommendationId: rec.id, userId } });
    await expect(
      prisma.upvote.create({ data: { recommendationId: rec.id, userId } }),
    ).rejects.toThrow();
  });

  it('removes upvotes and links when the recommendation goes', async () => {
    const rec = await make('Cascades');
    await prisma.upvote.create({ data: { recommendationId: rec.id, userId } });
    await prisma.recommendationLink.create({
      data: { recommendationId: rec.id, url: 'https://example.com', canonicalUrl: 'example.com' },
    });
    await prisma.recommendation.delete({ where: { id: rec.id } });
    expect(await prisma.upvote.count({ where: { recommendationId: rec.id } })).toBe(0);
    expect(await prisma.recommendationLink.count({ where: { recommendationId: rec.id } })).toBe(0);
  });

  it('removes recommendations when the creator goes', async () => {
    const owner = await prisma.user.create({ data: { patreonUserId: 'rec-owner-2' } });
    const doomed = await prisma.creator.create({
      data: {
        patreonCampaignId: 'doomed-campaign',
        ownerUserId: owner.id,
        displayName: 'Doomed',
        slug: 'doomed',
      },
    });
    await prisma.recommendation.create({
      data: {
        creatorId: doomed.id,
        submittedByUserId: owner.id,
        type: 'EXTERNAL_LINK',
        customTitle: 'Gone',
        normalizedTitle: 'gone',
      },
    });
    await prisma.creator.delete({ where: { id: doomed.id } });
    expect(await prisma.recommendation.count({ where: { creatorId: doomed.id } })).toBe(0);
  });
});
