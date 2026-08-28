import { BillingReconcileJob, RECONCILE_BATCH } from '../src/billing/billing-reconcile.job';
import { LemonSqueezyAdapter } from '../src/billing/lemon-squeezy.adapter';
import { AuthTestContext, startAuthApp } from './support/auth-app';

describe('Billing reconciliation (integration)', () => {
  let ctx: AuthTestContext;
  let job: BillingReconcileJob;
  let adapter: LemonSqueezyAdapter;
  let userId: string;

  const DAY = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    ctx = await startAuthApp();
    job = ctx.app.get(BillingReconcileJob);
    adapter = ctx.app.get(LemonSqueezyAdapter);
    userId = (await ctx.prisma.user.create({ data: { patreonUserId: 'rec-user' } })).id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await ctx.prisma.subscription.deleteMany();
    await ctx.prisma.user.update({
      where: { id: userId },
      data: { premiumUntil: new Date(Date.now() - DAY) },
    });
  });

  const seed = (
    overrides: Partial<{ status: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED'; end: Date }> = {},
  ) =>
    ctx.prisma.subscription.create({
      data: {
        userId,
        provider: 'lemonsqueezy',
        providerSubscriptionId: 'sub_stale',
        providerCustomerId: 'cus_1',
        status: overrides.status ?? 'ACTIVE',
        currentPeriodEnd: overrides.end ?? new Date(Date.now() - DAY),
      },
    });

  const answersWith = (value: unknown) =>
    jest.spyOn(adapter, 'fetchSubscription').mockResolvedValue(value as never);

  const premiumUntil = async () =>
    (await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } })).premiumUntil;

  it('picks up a renewal the webhook never delivered', async () => {
    // The only case that does not fail safe on its own: the reader paid and quietly lost premium.
    await seed();
    const renewedTo = new Date(Date.now() + 29 * DAY);
    answersWith({
      eventType: 'subscription_reconciled',
      userId: '',
      providerSubscriptionId: 'sub_stale',
      providerCustomerId: 'cus_1',
      status: 'ACTIVE',
      currentPeriodEnd: renewedTo,
      cancelAtPeriodEnd: false,
    });

    expect(await job.runOnce()).toBe(1);

    expect((await premiumUntil())?.getTime()).toBe(renewedTo.getTime());
  });

  it('leaves entitlement alone when the provider does not answer', async () => {
    // "The provider did not answer" and "the subscription ended" are different facts. Treating
    // the first as the second takes premium from somebody who is paying for it.
    await seed();
    await ctx.prisma.user.update({
      where: { id: userId },
      data: { premiumUntil: new Date(Date.now() + DAY) },
    });
    answersWith(null);

    expect(await job.runOnce()).toBe(0);

    expect((await premiumUntil())!.getTime()).toBeGreaterThan(Date.now());
    expect((await ctx.prisma.subscription.findFirstOrThrow()).status).toBe('ACTIVE');
  });

  it('keeps going when one subscription throws', async () => {
    await seed();
    jest.spyOn(adapter, 'fetchSubscription').mockRejectedValue(new Error('upstream down'));

    await expect(job.runOnce()).resolves.toBe(0);
  });

  it('ignores a cancelled subscription that simply reached its end', async () => {
    // Not a mystery worth a request: it ended exactly as it said it would.
    await seed({ status: 'CANCELLED' });
    const fetchSpy = answersWith(null);

    await job.runOnce();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores a subscription whose period has not run out', async () => {
    await seed({ end: new Date(Date.now() + 10 * DAY) });
    const fetchSpy = answersWith(null);

    await job.runOnce();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('takes a bounded batch', async () => {
    // Each one is a request to the provider, and the tick is shared with six other jobs.
    await ctx.prisma.subscription.deleteMany();
    const users = await Promise.all(
      Array.from({ length: RECONCILE_BATCH + 3 }, (_, i) =>
        ctx.prisma.user.create({ data: { patreonUserId: `rec-many-${i}` } }),
      ),
    );
    await ctx.prisma.subscription.createMany({
      data: users.map((u, i) => ({
        userId: u.id,
        provider: 'lemonsqueezy',
        providerSubscriptionId: `sub_many_${i}`,
        providerCustomerId: 'cus_1',
        status: 'ACTIVE' as const,
        currentPeriodEnd: new Date(Date.now() - DAY),
      })),
    });
    const fetchSpy = answersWith(null);

    await job.runOnce();

    expect(fetchSpy).toHaveBeenCalledTimes(RECONCILE_BATCH);
    await ctx.prisma.subscription.deleteMany();
    await ctx.prisma.user.deleteMany({ where: { patreonUserId: { startsWith: 'rec-many-' } } });
  });
});
