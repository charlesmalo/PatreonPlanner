import { PrismaClient } from '@prisma/client';
import { TokensService } from '../src/tokens/tokens.service';
import { startDatabase, type TestDatabase } from './support/database';
import { applyTestConfigDefaults } from './support/env';

/**
 * Granting.
 *
 * The property every test here defends: **granting must be safe to run twice**, because it will
 * be. Membership sync runs on webhooks, on a refresh job and on sign-in, and is transactional
 * with none of them, so a grant that is merely *usually* run once will one day run twice.
 */
describe('TokensService granting (integration)', () => {
  let pg: TestDatabase;
  let prisma: PrismaClient;
  let tokens: TokensService;
  let creatorId: string;
  let smallTierId: string;
  let bigTierId: string;
  let userId: string;

  beforeAll(async () => {
    pg = await startDatabase();
    prisma = new PrismaClient({ datasources: { db: { url: pg.getConnectionUri() } } });
    await prisma.$connect();
    process.env.DATABASE_URL = pg.getConnectionUri();
    process.env.REDIS_URL = 'redis://localhost:6379';
    applyTestConfigDefaults();
    tokens = new TokensService(prisma as never);
  }, 240_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await pg.stop();
  });

  beforeEach(async () => {
    await prisma.tokenLedger.deleteMany();
    await prisma.tokenBalance.deleteMany();
    await prisma.membership.deleteMany();
    await prisma.tier.deleteMany();
    await prisma.creatorPolicy.deleteMany();
    await prisma.creator.deleteMany();
    await prisma.user.deleteMany();

    const owner = await prisma.user.create({ data: { patreonUserId: 'tok-owner' } });
    const reader = await prisma.user.create({ data: { patreonUserId: 'tok-reader' } });
    userId = reader.id;

    const creator = await prisma.creator.create({
      data: {
        patreonCampaignId: 'tok-campaign',
        ownerUserId: owner.id,
        displayName: 'Token Co',
        slug: 'token-co',
        policy: { create: { viewVisibility: 'PUBLIC', redeemTokensEnabled: true } },
      },
    });
    creatorId = creator.id;

    smallTierId = (
      await prisma.tier.create({
        data: {
          creatorId,
          patreonTierId: 'tok-small',
          title: 'Sidekick',
          amountCents: 500,
          order: 0,
          tokensPerPeriod: 1,
        },
      })
    ).id;
    bigTierId = (
      await prisma.tier.create({
        data: {
          creatorId,
          patreonTierId: 'tok-big',
          title: 'Producer',
          amountCents: 1500,
          order: 1,
          tokensPerPeriod: 3,
        },
      })
    ).id;
  });

  const joinAt = (tierId: string | null, active = true) =>
    prisma.membership.create({
      data: { userId, creatorId, currentTierId: tierId, isActivePatron: active, amountCents: 500 },
    });

  const balanceOf = async () =>
    (await prisma.tokenBalance.findUnique({ where: { creatorId_userId: { creatorId, userId } } }))
      ?.available ?? 0;

  it('grants a tier its tokens for the current period', async () => {
    await joinAt(bigTierId);
    await tokens.grantDue(creatorId, userId, new Date('2026-09-24T00:00:00Z'));
    expect(await balanceOf()).toBe(3);
  });

  it('grants one period only once, however many times it is asked', async () => {
    // The whole point. Sync runs repeatedly and is transactional with nothing.
    await joinAt(bigTierId);
    const at = new Date('2026-09-24T00:00:00Z');
    await tokens.grantDue(creatorId, userId, at);
    await tokens.grantDue(creatorId, userId, at);
    await tokens.grantDue(creatorId, userId, at);

    expect(await balanceOf()).toBe(3);
    expect(await prisma.tokenLedger.count({ where: { creatorId, userId } })).toBe(1);
  });

  it('survives two grants racing for the same period', async () => {
    // The unique constraint, not a check-then-write, is what makes this safe.
    await joinAt(bigTierId);
    const at = new Date('2026-09-24T00:00:00Z');
    await Promise.all([
      tokens.grantDue(creatorId, userId, at),
      tokens.grantDue(creatorId, userId, at),
    ]);

    expect(await balanceOf()).toBe(3);
    expect(await prisma.tokenLedger.count({ where: { creatorId, userId } })).toBe(1);
  });

  it('grants the next period as well, without regranting the last', async () => {
    await joinAt(bigTierId);
    await tokens.grantDue(creatorId, userId, new Date('2026-09-24T00:00:00Z'));
    await tokens.grantDue(creatorId, userId, new Date('2026-10-02T00:00:00Z'));

    expect(await balanceOf()).toBe(6);
    expect(await prisma.tokenLedger.count({ where: { creatorId, userId } })).toBe(2);
  });

  it('grants nothing to a lapsed patron, and leaves what they already had', async () => {
    await joinAt(bigTierId);
    await tokens.grantDue(creatorId, userId, new Date('2026-09-24T00:00:00Z'));

    await prisma.membership.updateMany({
      where: { userId, creatorId },
      data: { isActivePatron: false },
    });
    await tokens.grantDue(creatorId, userId, new Date('2026-10-02T00:00:00Z'));

    expect(await balanceOf()).toBe(3);
  });

  it('grants nothing on a board that has the feature off', async () => {
    await prisma.creatorPolicy.update({
      where: { creatorId },
      data: { redeemTokensEnabled: false },
    });
    await joinAt(bigTierId);
    await tokens.grantDue(creatorId, userId, new Date('2026-09-24T00:00:00Z'));

    expect(await balanceOf()).toBe(0);
    expect(await prisma.tokenLedger.count({ where: { creatorId, userId } })).toBe(0);
  });

  it('grants nothing when the tier is set to zero, which is where every tier starts', async () => {
    await joinAt(smallTierId);
    await prisma.tier.update({ where: { id: smallTierId }, data: { tokensPerPeriod: 0 } });
    await tokens.grantDue(creatorId, userId, new Date('2026-09-24T00:00:00Z'));

    expect(await balanceOf()).toBe(0);
  });

  it('grants nothing to a member holding no tier', async () => {
    // A membership with an amount but no bound tier is a real state — it is why weighted voting
    // counts a tierless vote as one.
    await joinAt(null);
    await tokens.grantDue(creatorId, userId, new Date('2026-09-24T00:00:00Z'));

    expect(await balanceOf()).toBe(0);
  });

  it('grants by the tier the reader holds now, not the one they held then', async () => {
    // Upgrading mid-period does not retroactively regrant: the period is already granted, and
    // the unique constraint is per tier, so an upgrade must not hand out a second grant.
    await joinAt(smallTierId);
    const at = new Date('2026-09-24T00:00:00Z');
    await tokens.grantDue(creatorId, userId, at);
    expect(await balanceOf()).toBe(1);

    await prisma.membership.updateMany({
      where: { userId, creatorId },
      data: { currentTierId: bigTierId },
    });
    await tokens.grantDue(creatorId, userId, at);

    // Still one grant for this period. The next period grants at the new tier.
    expect(await balanceOf()).toBe(1);
    await tokens.grantDue(creatorId, userId, new Date('2026-10-02T00:00:00Z'));
    expect(await balanceOf()).toBe(4);
  });

  it('reports a real failure rather than swallowing it', async () => {
    // The catch exists to absorb *one* thing: the unique constraint refusing a period somebody
    // else granted first. Written as a bare `catch { return }` it also absorbs a dead connection,
    // a permissions error and a schema drift — and a grant that silently does nothing is a
    // balance that silently never grows, which nobody would think to look for.
    await joinAt(bigTierId);
    const broken = {
      creatorPolicy: { findUnique: async () => ({ redeemTokensEnabled: true }) },
      membership: {
        findUnique: async () => ({
          isActivePatron: true,
          currentTierId: bigTierId,
          currentTier: { tokensPerPeriod: 3 },
        }),
      },
      $transaction: async () => {
        throw new Error('connection terminated');
      },
    };
    const failing = new TokensService(broken as never);

    await expect(failing.grantDue(creatorId, userId)).rejects.toThrow('connection terminated');
  });

  it('records what a grant was for, so a balance can be explained', async () => {
    await joinAt(bigTierId);
    await tokens.grantDue(creatorId, userId, new Date('2026-09-24T00:00:00Z'));

    const row = await prisma.tokenLedger.findFirstOrThrow({ where: { creatorId, userId } });
    expect(row.kind).toBe('TIER_GRANT');
    expect(row.amount).toBe(3);
    expect(row.tierId).toBe(bigTierId);
    expect(row.periodKey).toBe('2026-09');
  });
});
