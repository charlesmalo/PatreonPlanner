import { PrismaClient } from '@prisma/client';
import {
  afterCursor,
  boardOrdering,
  encodeCursor,
  decodeCursor,
} from '../src/recommendations/board-query';
import { startDatabase, type TestDatabase } from './support/database';
import { applyTestConfigDefaults } from './support/env';

/**
 * Priority ordering, and the cursor that has to match it.
 *
 * The trap this file exists for: the keyset cursor mirrors the ordering column by column. A sort
 * Both are given `tokensEnabled: true` explicitly, because both default to *off*: a board that
 * enabled redeems, collected some and switched the feature off must stop ordering by them, and a
 * caller that forgets the flag gets the ordering of a board without the feature. That default is
 * why these four tests failed the moment the gate landed, which is the loud direction to fail in.
 *
 * key added to `boardOrdering` and not to `afterCursor` breaks pagination *silently* — page one
 * is correct and later pages skip or repeat rows. The comment on `isCreatorPick` in the cursor
 * says exactly this, and redeems need the same treatment.
 */
describe('Priority ordering (integration)', () => {
  let pg: TestDatabase;
  let prisma: PrismaClient;
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
    await prisma.recommendation.deleteMany();
    await prisma.creator.deleteMany();
    await prisma.user.deleteMany();
    const owner = await prisma.user.create({ data: { patreonUserId: 'pri-owner' } });
    creatorId = (
      await prisma.creator.create({
        data: {
          patreonCampaignId: 'pri-campaign',
          ownerUserId: owner.id,
          displayName: 'Priority Co',
          slug: 'priority-co',
          policy: { create: { viewVisibility: 'PUBLIC', redeemTokensEnabled: true } },
        },
      })
    ).id;
  });

  const make = async (
    title: string,
    over: { redeems?: number; pick?: boolean; score?: number } = {},
  ) => {
    const owner = await prisma.user.findFirstOrThrow();
    return prisma.recommendation.create({
      data: {
        creatorId,
        submittedByUserId: owner.id,
        type: 'EXTERNAL_LINK',
        customTitle: title,
        normalizedTitle: title.toLowerCase(),
        status: 'ACCEPTED',
        unconsumedRedeems: over.redeems ?? 0,
        isCreatorPick: over.pick ?? false,
        weightedScore: over.score ?? 0,
      },
    });
  };

  const titlesInOrder = async (take?: number, cursor?: string) =>
    (
      await prisma.recommendation.findMany({
        where: {
          creatorId,
          ...(cursor ? { AND: [afterCursor('upvotes', decodeCursor(cursor)!, true)] } : {}),
        },
        orderBy: boardOrdering('upvotes', true),
        ...(take ? { take } : {}),
      })
    ).map((r) => r.customTitle);

  it('puts a redeemed entry ahead of an unredeemed one', async () => {
    await make('Plain', { score: 10 });
    await make('Redeemed', { redeems: 1, score: 1 });

    expect(await titlesInOrder()).toEqual(['Redeemed', 'Plain']);
  });

  it('leaves a creator pick ahead of a redeemed entry', async () => {
    // A pick is the creator's own statement about their own board; a token is a request. When
    // they disagree, the person who owns the board wins.
    await make('Picked', { pick: true, score: 0 });
    await make('Redeemed', { redeems: 3, score: 99 });

    expect(await titlesInOrder()).toEqual(['Picked', 'Redeemed']);
  });

  it('orders more redeems ahead of fewer', async () => {
    await make('One', { redeems: 1 });
    await make('Three', { redeems: 3 });
    await make('Two', { redeems: 2 });

    expect(await titlesInOrder()).toEqual(['Three', 'Two', 'One']);
  });

  it('falls back to the chosen sort among entries with the same redeem count', async () => {
    await make('Low', { redeems: 2, score: 1 });
    await make('High', { redeems: 2, score: 50 });

    expect(await titlesInOrder()).toEqual(['High', 'Low']);
  });

  it('pages over a redeem-ordered column without skipping or repeating', async () => {
    // The failure this guards is silent: a sort key missing from the cursor makes page one
    // correct and every page after it wrong.
    // Scores deliberately run *against* the redeem order. If they agreed, `weightedScore` alone
    // would reproduce the right sequence and the cursor would never need the redeem key — which
    // is exactly the fixture this test had first, and a cursor missing that key passed it.
    await make('A', { redeems: 3, score: 1 });
    await make('B', { redeems: 2, score: 2 });
    await make('C', { redeems: 2, score: 1 });
    await make('D', { redeems: 0, score: 9 });
    await make('E', { redeems: 0, score: 8 });

    const all = await titlesInOrder();
    expect(all).toEqual(['A', 'B', 'C', 'D', 'E']);

    // Walk it two at a time and assert the walk reconstructs the same list exactly.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const rows = await prisma.recommendation.findMany({
        where: {
          creatorId,
          ...(cursor ? { AND: [afterCursor('upvotes', decodeCursor(cursor)!, true)] } : {}),
        },
        orderBy: boardOrdering('upvotes', true),
        take: 2,
      });
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.customTitle));
      cursor = encodeCursor(rows[rows.length - 1]);
    }

    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('pages correctly across the boundary between redeemed and unredeemed', async () => {
    // The boundary is where a missing cursor key does its damage: the last row of a page is
    // redeemed, the next page must start at the first unredeemed row and not repeat the group.
    // Again the scores oppose the redeem order, so crossing the boundary genuinely requires the
    // cursor to carry the redeem count.
    await make('R1', { redeems: 1, score: 2 });
    await make('R2', { redeems: 1, score: 1 });
    await make('P1', { redeems: 0, score: 9 });
    await make('P2', { redeems: 0, score: 8 });

    const firstPage = await prisma.recommendation.findMany({
      where: { creatorId },
      orderBy: boardOrdering('upvotes', true),
      take: 2,
    });
    expect(firstPage.map((r) => r.customTitle)).toEqual(['R1', 'R2']);

    const next = await titlesInOrder(undefined, encodeCursor(firstPage[1]));
    expect(next).toEqual(['P1', 'P2']);
  });
});
