import { PrismaClient } from '@prisma/client';
import { startDatabase, type TestDatabase } from './support/database';

describe('User model (integration)', () => {
  let pg: TestDatabase;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startDatabase();
    prisma = new PrismaClient({ datasources: { db: { url: pg.getConnectionUri() } } });
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await pg.stop();
  });

  it('enforces a unique patreonUserId', async () => {
    await prisma.user.create({ data: { patreonUserId: 'patreon-1', fullName: 'Ada' } });
    await expect(
      prisma.user.create({ data: { patreonUserId: 'patreon-1', fullName: 'Imposter' } }),
    ).rejects.toThrow();
  });

  it('enforces one membership per user per creator', async () => {
    const user = await prisma.user.create({ data: { patreonUserId: 'patreon-2' } });
    const creator = await prisma.creator.create({
      data: {
        patreonCampaignId: 'campaign-1',
        ownerUserId: user.id,
        displayName: 'Ada Writes',
        slug: 'ada-writes',
      },
    });
    await prisma.membership.create({ data: { userId: user.id, creatorId: creator.id } });
    await expect(
      prisma.membership.create({ data: { userId: user.id, creatorId: creator.id } }),
    ).rejects.toThrow();
  });
});
