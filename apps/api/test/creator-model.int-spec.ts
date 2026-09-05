import { PrismaClient } from '@prisma/client';
import { startDatabase, type TestDatabase } from './support/database';
import { ALL_STAFF_PERMISSIONS } from '../src/access/permissions';

describe('Creator staff and policy models (integration)', () => {
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

  async function seedCreator(suffix: string) {
    const owner = await prisma.user.create({ data: { patreonUserId: `owner-${suffix}` } });
    const creator = await prisma.creator.create({
      data: {
        patreonCampaignId: `campaign-${suffix}`,
        ownerUserId: owner.id,
        displayName: `Creator ${suffix}`,
        slug: `creator-${suffix}`,
      },
    });
    return { owner, creator };
  }

  it('allows only one staff row per user per creator', async () => {
    const { owner, creator } = await seedCreator('a');
    await prisma.creatorStaff.create({
      data: { creatorId: creator.id, userId: owner.id, role: 'OWNER' },
    });
    await expect(
      prisma.creatorStaff.create({
        data: {
          creatorId: creator.id,
          userId: owner.id,
          role: 'MOD',
          permissions: ALL_STAFF_PERMISSIONS,
        },
      }),
    ).rejects.toThrow();
  });

  it('allows only one policy per creator', async () => {
    const { creator } = await seedCreator('b');
    await prisma.creatorPolicy.create({ data: { creatorId: creator.id } });
    await expect(
      prisma.creatorPolicy.create({ data: { creatorId: creator.id } }),
    ).rejects.toThrow();
  });

  it('defaults a policy to subscribers-only with no tier gates', async () => {
    const { creator } = await seedCreator('c');
    const policy = await prisma.creatorPolicy.create({ data: { creatorId: creator.id } });
    expect(policy.viewVisibility).toBe('SUBSCRIBERS_ONLY');
    expect(policy.submitMinTierId).toBeNull();
    expect(policy.upvoteMinTierId).toBeNull();
    expect(policy.hidePendingFromPublic).toBe(false);
  });

  it('removes staff and policy when the creator is deleted', async () => {
    const { owner, creator } = await seedCreator('d');
    await prisma.creatorStaff.create({
      data: { creatorId: creator.id, userId: owner.id, role: 'OWNER' },
    });
    await prisma.creatorPolicy.create({ data: { creatorId: creator.id } });

    await prisma.creator.delete({ where: { id: creator.id } });

    expect(await prisma.creatorStaff.count({ where: { creatorId: creator.id } })).toBe(0);
    expect(await prisma.creatorPolicy.count({ where: { creatorId: creator.id } })).toBe(0);
  });

  it('keeps a claimed base url on the creator', async () => {
    const owner = await prisma.user.create({ data: { patreonUserId: 'owner-e' } });
    const creator = await prisma.creator.create({
      data: {
        patreonCampaignId: 'campaign-e',
        ownerUserId: owner.id,
        displayName: 'Creator E',
        slug: 'creator-e',
        baseUrl: 'https://e.example.com',
      },
    });
    expect(creator.baseUrl).toBe('https://e.example.com');
  });
});
