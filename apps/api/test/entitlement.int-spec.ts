import { GRACE_PERIOD_MS, EntitlementService } from '../src/billing/entitlement.service';
import { AuthTestContext, startAuthApp } from './support/auth-app';

describe('Entitlement (integration)', () => {
  let ctx: AuthTestContext;
  let entitlement: EntitlementService;
  let userId: string;

  const DAY = 24 * 60 * 60 * 1000;
  const ago = (ms: number) => new Date(Date.now() - ms);
  const ahead = (ms: number) => new Date(Date.now() + ms);

  beforeAll(async () => {
    ctx = await startAuthApp();
    entitlement = ctx.app.get(EntitlementService);
    userId = (await ctx.prisma.user.create({ data: { patreonUserId: 'ent-user' } })).id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.subscription.deleteMany();
    await ctx.prisma.user.update({ where: { id: userId }, data: { premiumUntil: null } });
  });

  const apply = (state: {
    status: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED' | 'REFUNDED';
    currentPeriodEnd: Date;
    cancelAtPeriodEnd?: boolean;
  }) =>
    entitlement.applyTo(userId, {
      status: state.status,
      currentPeriodEnd: state.currentPeriodEnd,
      cancelAtPeriodEnd: state.cancelAtPeriodEnd ?? false,
    });

  const premiumUntil = async () =>
    (await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } })).premiumUntil;

  const isPremium = async () => {
    const until = await premiumUntil();
    return until !== null && until > new Date();
  };

  it('grants premium to the end of the paid period', async () => {
    const end = ahead(30 * DAY);

    await apply({ status: 'ACTIVE', currentPeriodEnd: end });

    expect((await premiumUntil())?.getTime()).toBe(end.getTime());
  });

  it('keeps premium through a grace window when a payment fails', async () => {
    // A card that expired on Tuesday is not a reader who stopped paying. Revoking mid-retry is a
    // worse experience than the retry succeeding a day later.
    await apply({ status: 'PAST_DUE', currentPeriodEnd: ago(DAY) });

    expect(await isPremium()).toBe(true);
  });

  it('revokes once the grace window has passed', async () => {
    await apply({ status: 'PAST_DUE', currentPeriodEnd: ago(GRACE_PERIOD_MS + DAY) });

    expect(await isPremium()).toBe(false);
  });

  it('revokes immediately when a subscription is refunded', async () => {
    // Not the same as lapsing: the money went back, so the entitlement goes with it and no grace
    // applies. A grace window on a refund is a window for buying premium and taking it back.
    await apply({ status: 'REFUNDED', currentPeriodEnd: ahead(30 * DAY) });

    expect(await isPremium()).toBe(false);
  });

  it('keeps premium to the period end when cancelled', async () => {
    // Cancelling stops the renewal; it does not take back the month already paid for.
    const end = ahead(20 * DAY);

    await apply({ status: 'CANCELLED', currentPeriodEnd: end, cancelAtPeriodEnd: true });

    expect((await premiumUntil())?.getTime()).toBe(end.getTime());
  });

  it('revokes when a cancelled subscription reaches its period end', async () => {
    await apply({ status: 'CANCELLED', currentPeriodEnd: ago(DAY), cancelAtPeriodEnd: true });

    expect(await isPremium()).toBe(false);
  });

  it('never shortens premium somebody already has', async () => {
    // Providers do not promise ordering, so a renewal and the event before it can arrive the
    // wrong way round. Taking the later of the two dates means a stale event cannot revoke a
    // renewal that already landed.
    const renewed = ahead(60 * DAY);
    await apply({ status: 'ACTIVE', currentPeriodEnd: renewed });

    await apply({ status: 'ACTIVE', currentPeriodEnd: ahead(30 * DAY) });

    expect((await premiumUntil())?.getTime()).toBe(renewed.getTime());
  });

  it('shortens it anyway when the money went back', async () => {
    // The one case where going backwards is right, and the reason the rule above is not simply
    // "always take the later date".
    await apply({ status: 'ACTIVE', currentPeriodEnd: ahead(60 * DAY) });

    await apply({ status: 'REFUNDED', currentPeriodEnd: ahead(60 * DAY) });

    expect(await isPremium()).toBe(false);
  });
});
