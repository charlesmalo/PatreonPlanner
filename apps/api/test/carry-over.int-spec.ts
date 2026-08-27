import { CARRY_OVER_BATCH, CarryOverService } from '../src/carry-over/carry-over.service';
import { RateLimitService } from '../src/limits/rate-limit.service';
import { AuthTestContext, startAuthApp } from './support/auth-app';

describe('Carrying a list across boards (integration)', () => {
  let ctx: AuthTestContext;
  let carryOver: CarryOverService;
  let limits: RateLimitService;
  let sourceCreatorId: string;
  let targetCreatorId: string;
  let patron: string;
  let owner: string;
  let sourceId: string;

  const originalLimits = {
    perHour: process.env.SUBMIT_LIMIT_PER_HOUR,
    global: process.env.SUBMIT_LIMIT_PER_HOUR_GLOBAL,
  };

  beforeAll(async () => {
    // Set before boot: config is validated once at startup. Generous by default so the tests that
    // are not about limits do not trip over them; the one that is sets its own.
    process.env.SUBMIT_LIMIT_PER_HOUR = '50';
    process.env.SUBMIT_LIMIT_PER_HOUR_GLOBAL = '200';
    ctx = await startAuthApp();
    carryOver = ctx.app.get(CarryOverService);
    limits = ctx.app.get(RateLimitService);

    owner = (await ctx.prisma.user.create({ data: { patreonUserId: 'co-owner' } })).id;
    patron = (await ctx.prisma.user.create({ data: { patreonUserId: 'co-patron' } })).id;

    const board = async (slug: string, campaign: string) =>
      (
        await ctx.prisma.creator.create({
          data: {
            patreonCampaignId: campaign,
            ownerUserId: owner,
            displayName: slug,
            slug,
            policy: { create: {} },
            staff: { create: { userId: owner, role: 'OWNER' } },
          },
        })
      ).id;
    sourceCreatorId = await board('co-source', 'co-campaign-1');
    targetCreatorId = await board('co-target', 'co-campaign-2');

    for (const creatorId of [sourceCreatorId, targetCreatorId]) {
      await ctx.prisma.membership.create({
        data: { userId: patron, creatorId, amountCents: 500, isActivePatron: true },
      });
    }
  }, 300_000);

  afterAll(async () => {
    await ctx.teardown();
    for (const [key, value] of Object.entries(originalLimits)) {
      const name = key === 'perHour' ? 'SUBMIT_LIMIT_PER_HOUR' : 'SUBMIT_LIMIT_PER_HOUR_GLOBAL';
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  beforeEach(async () => {
    await ctx.prisma.carryOverDelivery.deleteMany();
    await ctx.prisma.recommendation.deleteMany();
    await ctx.prisma.abuseRecord.deleteMany();
    // Drained, not decremented. `refund` gives back one allowance, and the rate-limit test below
    // spends the whole window — leaving it near the cap would fail the next test that submits,
    // for a reason nowhere near where it was caused.
    const key = `submit:${patron}:${targetCreatorId}`;
    for (let spent = await limits.count(key, 3600); spent > 0; spent -= 1) {
      await limits.refund(key);
    }
    await ctx.prisma.creatorPolicy.updateMany({ data: { acceptsCarryOver: true } });
    await ctx.prisma.membership.updateMany({
      where: { userId: patron },
      data: { isActivePatron: true, amountCents: 500 },
    });
    sourceId = (
      await ctx.prisma.recommendation.create({
        data: {
          creatorId: sourceCreatorId,
          submittedByUserId: patron,
          type: 'EXTERNAL_LINK',
          customTitle: 'Perfect Blue',
          normalizedTitle: 'perfect blue',
        },
      })
    ).id;
  });

  /** Queue this reader's one entry at the second board, then run it. */
  async function deliver() {
    await carryOver.enqueue(patron, [sourceId], [targetCreatorId]);
    const queued = await ctx.prisma.carryOverDelivery.findFirstOrThrow({
      where: { userId: patron, creatorId: targetCreatorId },
    });
    await carryOver.deliver(queued.id);
    return ctx.prisma.carryOverDelivery.findUniqueOrThrow({ where: { id: queued.id } });
  }

  const entriesOn = (creatorId: string) =>
    ctx.prisma.recommendation.findMany({ where: { creatorId } });

  it('submits a title the board has not seen', async () => {
    const delivery = await deliver();

    expect(delivery.outcome).toBe('SUBMITTED');
    const [entry] = await entriesOn(targetCreatorId);
    expect(entry.customTitle).toBe('Perfect Blue');
    expect(delivery.resultRecommendationId).toBe(entry.id);
  });

  it('labels what it creates, so a moderator can judge them as a class', async () => {
    await deliver();

    const [entry] = await entriesOn(targetCreatorId);
    expect(entry.viaCarryOver).toBe(true);
  });

  it('reports an entry already on the board rather than voting for it', async () => {
    // An upvote is a direct, tier-weighted input to the ordering with no moderator between it
    // and the board. Casting one for content the reader never looked at is the thing this must
    // not do, however convenient it would be.
    const existing = await ctx.prisma.recommendation.create({
      data: {
        creatorId: targetCreatorId,
        submittedByUserId: owner,
        type: 'EXTERNAL_LINK',
        customTitle: 'Perfect Blue',
        normalizedTitle: 'perfect blue',
      },
    });

    const delivery = await deliver();

    expect(delivery.outcome).toBe('ALREADY_PRESENT');
    expect(delivery.resultRecommendationId).toBe(existing.id);
    expect(await ctx.prisma.upvote.count({ where: { recommendationId: existing.id } })).toBe(0);
    expect(await entriesOn(targetCreatorId)).toHaveLength(1);
  });

  it('never re-proposes what that board already refused', async () => {
    // De-duplication filters on notIn HIDDEN_STATUSES, which contains REJECTED, so a person can
    // resubmit after fixing whatever was wrong. A queue has no judgement to exercise and would
    // re-propose refused content on a schedule.
    await ctx.prisma.recommendation.create({
      data: {
        creatorId: targetCreatorId,
        submittedByUserId: owner,
        type: 'EXTERNAL_LINK',
        customTitle: 'Perfect Blue',
        normalizedTitle: 'perfect blue',
        status: 'REJECTED',
      },
    });

    const delivery = await deliver();

    expect(delivery.outcome).toBe('REFUSED_BEFORE');
    expect(await entriesOn(targetCreatorId)).toHaveLength(1);
  });

  it('respects a creator who has switched carry-over off', async () => {
    await ctx.prisma.creatorPolicy.update({
      where: { creatorId: targetCreatorId },
      data: { acceptsCarryOver: false },
    });

    const delivery = await deliver();

    expect(delivery.outcome).toBe('NOT_ACCEPTED');
    expect(await entriesOn(targetCreatorId)).toHaveLength(0);
  });

  it('does not deliver to a board the reader may no longer submit to', async () => {
    // Eligibility is resolved when the delivery runs, not when it was queued: a pledge can lapse
    // between the two, and a queue must not outlive the entitlement that authorised it.
    const tier = await ctx.prisma.tier.create({
      data: {
        creatorId: targetCreatorId,
        patreonTierId: 'co-tier',
        title: 'Supporter',
        amountCents: 1000,
        order: 0,
      },
    });
    await ctx.prisma.creatorPolicy.update({
      where: { creatorId: targetCreatorId },
      data: { submitMinTierId: tier.id },
    });
    try {
      const delivery = await deliver();

      expect(delivery.outcome).toBe('NOT_ELIGIBLE');
      expect(await entriesOn(targetCreatorId)).toHaveLength(0);
    } finally {
      await ctx.prisma.creatorPolicy.update({
        where: { creatorId: targetCreatorId },
        data: { submitMinTierId: null },
      });
      await ctx.prisma.tier.delete({ where: { id: tier.id } });
    }
  });

  it('waits rather than failing when the board’s own limit is reached', async () => {
    // The per-board quota is the creator's policy about how much one patron may put in front of
    // them. The queue waits at it rather than pushing past it — and burning the delivery on a 429
    // would make the feature quietly lossy, which is the failure people notice last and trust
    // least. Spending the allowance directly rather than submitting fifty times.
    const limit = Number(process.env.SUBMIT_LIMIT_PER_HOUR);
    for (let i = 0; i < limit; i += 1) {
      await limits.consume(`submit:${patron}:${targetCreatorId}`, limit, 3600);
    }

    const delivery = await deliver();

    expect(delivery.outcome).toBe('PENDING');
    expect(delivery.processedAt).toBeNull();
    expect(await entriesOn(targetCreatorId)).toHaveLength(0);
  });

  it('is idempotent: broadcasting the same list twice queues one delivery', async () => {
    await carryOver.enqueue(patron, [sourceId], [targetCreatorId]);
    await carryOver.enqueue(patron, [sourceId], [targetCreatorId]);

    expect(await ctx.prisma.carryOverDelivery.count({ where: { userId: patron } })).toBe(1);
  });

  describe('draining the queue', () => {
    it('processes what is waiting and leaves nothing behind', async () => {
      await carryOver.enqueue(patron, [sourceId], [targetCreatorId]);

      const processed = await carryOver.runOnce();

      expect(processed).toBe(1);
      expect(await ctx.prisma.carryOverDelivery.count({ where: { outcome: 'PENDING' } })).toBe(0);
    });

    it('does not process a delivery twice', async () => {
      // The drain is not the only caller and a tick can overlap a slow one. Re-delivering would
      // submit the same title again, which the board sees as a duplicate and the reader sees as
      // the feature spamming on their behalf.
      await carryOver.enqueue(patron, [sourceId], [targetCreatorId]);
      await carryOver.runOnce();

      expect(await carryOver.runOnce()).toBe(0);
      expect(await entriesOn(targetCreatorId)).toHaveLength(1);
    });

    it('refuses to deliver a row that has already been settled', async () => {
      // The guard for an overlapping tick, which `runOnce` alone cannot reach because it only
      // ever selects PENDING rows. Without it a slow tick and the next one both deliver the same
      // title, and the board sees a duplicate the reader never asked for twice.
      await carryOver.enqueue(patron, [sourceId], [targetCreatorId]);
      const delivery = await ctx.prisma.carryOverDelivery.findFirstOrThrow({});
      await carryOver.deliver(delivery.id);

      await carryOver.deliver(delivery.id);

      expect(await entriesOn(targetCreatorId)).toHaveLength(1);
      // The damage a second delivery does is not a duplicate entry — de-duplication catches that
      // — it is rewriting a settled outcome. SUBMITTED becoming ALREADY_PRESENT tells the reader
      // their title was already on the board when in fact they are the one who put it there.
      const after = await ctx.prisma.carryOverDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      expect(after.outcome).toBe('SUBMITTED');
    });

    it('takes a bounded batch rather than everything waiting', async () => {
      // A reader with forty titles across ten boards is four hundred deliveries, each one a
      // submission with moderation and a catalogue call behind it. An unbounded tick holds the
      // worker while five other jobs wait on it.
      const many = await Promise.all(
        Array.from({ length: CARRY_OVER_BATCH + 3 }, (_, i) =>
          ctx.prisma.recommendation.create({
            data: {
              creatorId: sourceCreatorId,
              submittedByUserId: patron,
              type: 'EXTERNAL_LINK',
              customTitle: `Batch ${i}`,
              normalizedTitle: `batch ${i}`,
            },
          }),
        ),
      );
      await carryOver.enqueue(
        patron,
        many.map((m) => m.id),
        [targetCreatorId],
      );

      expect(await carryOver.runOnce()).toBe(CARRY_OVER_BATCH);
    });

    it('keeps going when one delivery fails', async () => {
      // One bad row must not strand every other reader's list behind it.
      const other = await ctx.prisma.recommendation.create({
        data: {
          creatorId: sourceCreatorId,
          submittedByUserId: patron,
          type: 'EXTERNAL_LINK',
          customTitle: 'Paprika',
          normalizedTitle: 'paprika',
        },
      });
      await carryOver.enqueue(patron, [sourceId, other.id], [targetCreatorId]);
      // Break exactly one of them: a source with no title of any kind cannot make a valid DTO.
      await ctx.prisma.recommendation.update({
        where: { id: other.id },
        data: { customTitle: '' },
      });

      await carryOver.runOnce();

      const outcomes = await ctx.prisma.carryOverDelivery.findMany({ select: { outcome: true } });
      expect(outcomes.map((o) => o.outcome).sort()).toEqual(['FAILED', 'SUBMITTED']);
    });

    it('retries a delivery the rate limit made it wait on', async () => {
      const limit = Number(process.env.SUBMIT_LIMIT_PER_HOUR);
      const key = `submit:${patron}:${targetCreatorId}`;
      for (let i = 0; i < limit; i += 1) await limits.consume(key, limit, 3600);
      await carryOver.enqueue(patron, [sourceId], [targetCreatorId]);

      await carryOver.runOnce();
      expect(await ctx.prisma.carryOverDelivery.count({ where: { outcome: 'PENDING' } })).toBe(1);

      // ...and once the window has room again, the next tick delivers it.
      for (let spent = await limits.count(key, 3600); spent > 0; spent -= 1)
        await limits.refund(key);
      await carryOver.runOnce();

      expect(await ctx.prisma.carryOverDelivery.count({ where: { outcome: 'SUBMITTED' } })).toBe(1);
    });
  });

  it('refuses to carry an entry that is not the reader’s own', async () => {
    const someoneElse = await ctx.prisma.recommendation.create({
      data: {
        creatorId: sourceCreatorId,
        submittedByUserId: owner,
        type: 'EXTERNAL_LINK',
        customTitle: 'Not Theirs',
        normalizedTitle: 'not theirs',
      },
    });

    await carryOver.enqueue(patron, [someoneElse.id], [targetCreatorId]);

    expect(await ctx.prisma.carryOverDelivery.count({ where: { userId: patron } })).toBe(0);
  });
});
