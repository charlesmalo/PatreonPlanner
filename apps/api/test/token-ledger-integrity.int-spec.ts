import { PrismaClient } from '@prisma/client';
import { TokensService } from '../src/tokens/tokens.service';
import { findLedgerDiscrepancies } from '../src/tokens/reconcile';
import { startDatabase, type TestDatabase } from './support/database';
import { applyTestConfigDefaults } from './support/env';

/**
 * The ledger against the balance.
 *
 * `TokenBalance.available` is a cache of `SUM(TokenLedger.amount)`, kept so that spending is one
 * conditional decrement rather than an aggregate read. Nothing in the product notices when the
 * two drift, and a patron would simply see a number that is not their tokens.
 *
 * So the check is exercised against balances built by the real service — a drift caused by a
 * bug in `grantDue` or `spend` is the case that matters, and a fixture that writes both sides by
 * hand cannot catch one.
 */
describe('Token ledger integrity (integration)', () => {
  let pg: TestDatabase;
  let prisma: PrismaClient;
  let tokens: TokensService;
  let creatorId: string;
  let otherCreatorId: string;
  let userId: string;
  let tierId: string;
  let acceptedId: string;

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
    await prisma.membership.deleteMany();
    await prisma.tier.deleteMany();
    await prisma.creatorPolicy.deleteMany();
    await prisma.creator.deleteMany();
    await prisma.user.deleteMany();

    const owner = await prisma.user.create({ data: { patreonUserId: 'int-owner' } });
    const reader = await prisma.user.create({ data: { patreonUserId: 'int-reader' } });
    userId = reader.id;

    const creator = await prisma.creator.create({
      data: {
        patreonCampaignId: 'int-campaign',
        ownerUserId: owner.id,
        displayName: 'Integrity Co',
        slug: 'integrity-co',
        policy: { create: { viewVisibility: 'PUBLIC', redeemTokensEnabled: true } },
      },
    });
    creatorId = creator.id;

    const other = await prisma.creator.create({
      data: {
        patreonCampaignId: 'int-campaign-2',
        ownerUserId: owner.id,
        displayName: 'Other Co',
        slug: 'other-co',
        policy: { create: { viewVisibility: 'PUBLIC', redeemTokensEnabled: true } },
      },
    });
    otherCreatorId = other.id;

    const tier = await prisma.tier.create({
      data: {
        creatorId,
        patreonTierId: 'int-tier',
        title: 'Producer',
        amountCents: 1500,
        order: 1,
        tokensPerPeriod: 3,
      },
    });
    tierId = tier.id;
    await prisma.membership.create({
      data: { creatorId, userId, currentTierId: tierId, isActivePatron: true, amountCents: 1500 },
    });

    const entry = await prisma.recommendation.create({
      data: {
        creatorId,
        submittedByUserId: userId,
        type: 'EXTERNAL_LINK',
        customTitle: 'Accepted One',
        normalizedTitle: 'accepted one',
        status: 'ACCEPTED',
      },
    });
    acceptedId = entry.id;
  });

  it('finds nothing wrong with balances the service built', async () => {
    // A grant, a creator bonus and a spend — every write that touches both sides.
    await tokens.grantDue(creatorId, userId, new Date('2026-09-15T00:00:00.000Z'));
    await tokens.grantDirect(creatorId, userId, 2, 'for moderating');
    await tokens.spend(creatorId, userId, acceptedId, 'S2E04');

    expect(await findLedgerDiscrepancies(prisma)).toEqual([]);
    const balance = await prisma.tokenBalance.findUniqueOrThrow({
      where: { creatorId_userId: { creatorId, userId } },
    });
    expect(balance.available).toBe(4);
  });

  it("reports a balance edited behind the ledger's back", async () => {
    await tokens.grantDue(creatorId, userId, new Date('2026-09-15T00:00:00.000Z'));

    // What a hand-edit in psql looks like, and what a bug in a future write path would look
    // like: the number moves and nothing explains it.
    await prisma.tokenBalance.update({
      where: { creatorId_userId: { creatorId, userId } },
      data: { available: 99 },
    });

    expect(await findLedgerDiscrepancies(prisma)).toEqual([
      { creatorId, userId, available: 99, ledgerSum: 3 },
    ]);
  });

  it("reports a ledger row removed behind the balance's back", async () => {
    // The mirror image, and the more dangerous direction: the ledger is the record, so a lost
    // row means tokens a reader can spend that nothing accounts for.
    await tokens.grantDue(creatorId, userId, new Date('2026-09-15T00:00:00.000Z'));
    await prisma.tokenLedger.deleteMany({ where: { creatorId, userId } });

    expect(await findLedgerDiscrepancies(prisma)).toEqual([
      { creatorId, userId, available: 3, ledgerSum: null },
    ]);
  });

  it('reports ledger rows with no balance row to spend from', async () => {
    // Granted and unspendable. Scanning balances alone would never see this reader at all,
    // which is why the check is a full outer join and not a loop over balances.
    await tokens.grantDue(creatorId, userId, new Date('2026-09-15T00:00:00.000Z'));
    await prisma.tokenBalance.deleteMany({ where: { creatorId, userId } });

    expect(await findLedgerDiscrepancies(prisma)).toEqual([
      { creatorId, userId, available: null, ledgerSum: 3 },
    ]);
  });

  it("keeps one board's books separate from another's", async () => {
    // Balances are per creator. A check that summed a reader's rows across boards would call
    // every multi-board reader broken.
    await tokens.grantDue(creatorId, userId, new Date('2026-09-15T00:00:00.000Z'));
    await prisma.tokenBalance.create({
      data: { creatorId: otherCreatorId, userId, available: 7 },
    });

    expect(await findLedgerDiscrepancies(prisma, creatorId)).toEqual([]);
    expect(await findLedgerDiscrepancies(prisma, otherCreatorId)).toEqual([
      { creatorId: otherCreatorId, userId, available: 7, ledgerSum: null },
    ]);
    expect(await findLedgerDiscrepancies(prisma)).toHaveLength(1);
  });

  it('is unaffected by which tier granted what', async () => {
    // `tierId` is deliberately outside the idempotency key. This asserts the sum does not care
    // either — a reader who changed tier mid-period still balances.
    const second = await prisma.tier.create({
      data: {
        creatorId,
        patreonTierId: 'int-tier-2',
        title: 'Sidekick',
        amountCents: 500,
        order: 0,
        tokensPerPeriod: 1,
      },
    });
    await tokens.grantDue(creatorId, userId, new Date('2026-09-15T00:00:00.000Z'));
    await prisma.membership.updateMany({
      where: { creatorId, userId },
      data: { currentTierId: second.id },
    });
    await tokens.grantDue(creatorId, userId, new Date('2026-09-20T00:00:00.000Z'));

    expect(await findLedgerDiscrepancies(prisma)).toEqual([]);
    expect(await prisma.tokenLedger.count({ where: { creatorId, userId } })).toBe(1);
    expect(tierId).not.toBe(second.id);
  });
});
