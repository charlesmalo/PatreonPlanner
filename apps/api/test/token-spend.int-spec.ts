import { PrismaClient } from '@prisma/client';
import { TokensService } from '../src/tokens/tokens.service';
import { startDatabase, type TestDatabase } from './support/database';
import { applyTestConfigDefaults } from './support/env';

/**
 * Spending.
 *
 * The property every test here defends: **a balance must never go below zero**, whatever two
 * requests do at the same instant. A read-then-write would let two spends both see a balance of
 * one and both succeed — the same failure the moderation status change already guards against,
 * and for the same reason.
 */
describe('TokensService spending (integration)', () => {
  let pg: TestDatabase;
  let prisma: PrismaClient;
  let tokens: TokensService;
  let creatorId: string;
  let userId: string;
  let acceptedId: string;
  let pendingId: string;

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
    await prisma.redeem.deleteMany();
    await prisma.tokenBalance.deleteMany();
    await prisma.recommendation.deleteMany();
    await prisma.creatorPolicy.deleteMany();
    await prisma.creator.deleteMany();
    await prisma.user.deleteMany();

    const owner = await prisma.user.create({ data: { patreonUserId: 'sp-owner' } });
    const reader = await prisma.user.create({ data: { patreonUserId: 'sp-reader' } });
    userId = reader.id;

    const creator = await prisma.creator.create({
      data: {
        patreonCampaignId: 'sp-campaign',
        ownerUserId: owner.id,
        displayName: 'Spend Co',
        slug: 'spend-co',
        policy: { create: { viewVisibility: 'PUBLIC', redeemTokensEnabled: true } },
      },
    });
    creatorId = creator.id;

    const entry = (status: 'ACCEPTED' | 'PENDING', title: string) =>
      prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: reader.id,
          type: 'EXTERNAL_LINK',
          customTitle: title,
          normalizedTitle: title.toLowerCase(),
          status,
        },
      });
    acceptedId = (await entry('ACCEPTED', 'Accepted One')).id;
    pendingId = (await entry('PENDING', 'Pending One')).id;
  });

  const give = (available: number) =>
    prisma.tokenBalance.create({ data: { creatorId, userId, available } });

  const balanceOf = async () =>
    (await prisma.tokenBalance.findUnique({ where: { creatorId_userId: { creatorId, userId } } }))
      ?.available ?? 0;

  const countOn = async (id: string) =>
    (await prisma.recommendation.findUniqueOrThrow({ where: { id } })).unconsumedRedeems;

  it('spends a token on an accepted entry', async () => {
    await give(2);
    await tokens.spend(creatorId, userId, acceptedId, 'S2E04');

    expect(await balanceOf()).toBe(1);
    expect(await countOn(acceptedId)).toBe(1);
    const redeem = await prisma.redeem.findFirstOrThrow({
      where: { recommendationId: acceptedId },
    });
    expect(redeem.note).toBe('S2E04');
    expect(redeem.consumedAt).toBeNull();
  });

  it('records the spend in the ledger as a negative amount', async () => {
    // Positive for a grant, negative for a spend, so the column sums to the balance.
    await give(1);
    await tokens.spend(creatorId, userId, acceptedId, 'S2E04');

    const row = await prisma.tokenLedger.findFirstOrThrow({ where: { creatorId, userId } });
    expect(row.kind).toBe('SPEND');
    expect(row.amount).toBe(-1);
    expect(row.redeemId).not.toBeNull();
  });

  it('refuses an entry that has not passed moderation', async () => {
    // A token must not be able to skip the queue — that is the one thing the queue exists for.
    await give(1);
    await expect(tokens.spend(creatorId, userId, pendingId, 'S2E04')).rejects.toThrow();

    expect(await balanceOf()).toBe(1);
    expect(await prisma.redeem.count()).toBe(0);
  });

  it('refuses a reader with no tokens', async () => {
    await give(0);
    await expect(tokens.spend(creatorId, userId, acceptedId, 'S2E04')).rejects.toThrow();
    expect(await countOn(acceptedId)).toBe(0);
  });

  it('refuses a reader who has never had a balance at all', async () => {
    await expect(tokens.spend(creatorId, userId, acceptedId, 'S2E04')).rejects.toThrow();
    expect(await prisma.redeem.count()).toBe(0);
  });

  it('never takes a balance below zero, whatever races', async () => {
    // Two spends from a balance of one, forced to genuinely overlap.
    //
    // `Promise.allSettled` over two ordinary calls is NOT enough: each transaction is short
    // enough to finish before the other starts, so a read-then-write implementation passes it.
    // Measured — a deliberately broken version survived exactly that test, which is how this
    // one came to hold a transaction open instead.
    //
    // Holding the first transaction open past the decrement is what makes the interleave real:
    // the second spend runs while the first has decremented but not committed.
    await give(1);

    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = prisma.$transaction(async (tx) => {
      const { count } = await tx.tokenBalance.updateMany({
        where: { creatorId, userId, available: { gt: 0 } },
        data: { available: { decrement: 1 } },
      });
      expect(count).toBe(1);
      await firstMayFinish;
      const redeem = await tx.redeem.create({
        data: { creatorId, recommendationId: acceptedId, userId, note: 'first' },
        select: { id: true },
      });
      await tx.tokenLedger.create({
        data: { creatorId, userId, kind: 'SPEND', amount: -1, redeemId: redeem.id },
      });
      await tx.recommendation.update({
        where: { id: acceptedId },
        data: { unconsumedRedeems: { increment: 1 } },
      });
    });

    // The second spend now runs against a row the first has already decremented. Under a
    // conditional decrement it blocks on the uncommitted row and then finds zero; under a
    // read-then-write it would read the pre-decrement value and hand out a token that is gone.
    const second = tokens.spend(creatorId, userId, acceptedId, 'second').then(
      () => 'spent' as const,
      () => 'refused' as const,
    );

    // Let the holder commit, then see what the second one did.
    setTimeout(() => releaseFirst(), 150);
    await first;
    expect(await second).toBe('refused');

    expect(await balanceOf()).toBe(0);
    expect(await prisma.redeem.count()).toBe(1);
    expect(await countOn(acceptedId)).toBe(1);
  });

  it('lets one reader spend twice on the same entry, each with its own note', async () => {
    await give(2);
    await tokens.spend(creatorId, userId, acceptedId, 'S2E04');
    await tokens.spend(creatorId, userId, acceptedId, 'and S2E05');

    expect(await countOn(acceptedId)).toBe(2);
    expect(await balanceOf()).toBe(0);
    const notes = (await prisma.redeem.findMany({ orderBy: { createdAt: 'asc' } })).map(
      (r) => r.note,
    );
    expect(notes).toEqual(['S2E04', 'and S2E05']);
  });

  it('refuses an entry belonging to another creator', async () => {
    // Scoped by creatorId: an id alone says nothing about which board owns it, and a token on
    // one board must never be spendable on another.
    const otherOwner = await prisma.user.create({ data: { patreonUserId: 'sp-other' } });
    const other = await prisma.creator.create({
      data: {
        patreonCampaignId: 'sp-other-campaign',
        ownerUserId: otherOwner.id,
        displayName: 'Other Co',
        slug: 'other-co',
        policy: { create: { viewVisibility: 'PUBLIC', redeemTokensEnabled: true } },
      },
    });
    const foreign = await prisma.recommendation.create({
      data: {
        creatorId: other.id,
        submittedByUserId: otherOwner.id,
        type: 'EXTERNAL_LINK',
        customTitle: 'Foreign',
        normalizedTitle: 'foreign',
        status: 'ACCEPTED',
      },
    });

    await give(1);
    await expect(tokens.spend(creatorId, userId, foreign.id, 'S2E04')).rejects.toThrow();
    expect(await balanceOf()).toBe(1);
  });

  it('refuses to spend on a board that has the feature off', async () => {
    await prisma.creatorPolicy.update({
      where: { creatorId },
      data: { redeemTokensEnabled: false },
    });
    await give(1);

    await expect(tokens.spend(creatorId, userId, acceptedId, 'S2E04')).rejects.toThrow();
    expect(await balanceOf()).toBe(1);
  });

  it('refuses an empty note, because the note is the whole instruction', async () => {
    await give(1);
    await expect(tokens.spend(creatorId, userId, acceptedId, '   ')).rejects.toThrow();
    expect(await balanceOf()).toBe(1);
  });
});
