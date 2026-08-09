import { createHmac } from 'node:crypto';
import request from 'supertest';
import { AuthTestContext, startAuthApp } from './support/auth-app';

describe('POST /webhooks/patreon (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let tierId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'hook-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'hook-campaign',
        ownerUserId: owner.id,
        displayName: 'Hook Co',
        slug: 'hook-co',
        tiers: {
          create: [{ patreonTierId: 'h-tier', title: 'Gold', amountCents: 1000, order: 0 }],
        },
        policy: { create: {} },
      },
      include: { tiers: true },
    });
    creatorId = creator.id;
    tierId = creator.tiers[0].id;
    const patron = await ctx.prisma.user.create({ data: { patreonUserId: 'hook-patron' } });
    userId = patron.id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  function event(trigger: string, body: object) {
    const raw = JSON.stringify(body);
    const signature = createHmac('md5', process.env.PATREON_WEBHOOK_SECRET as string)
      .update(Buffer.from(raw))
      .digest('hex');
    return request(ctx.app.getHttpServer())
      .post('/webhooks/patreon')
      .set('X-Patreon-Event', trigger)
      .set('X-Patreon-Signature', signature)
      .set('Content-Type', 'application/json')
      .send(raw);
  }

  const pledge = (opts: { status: string; cents: number; tiers?: string[] }) => ({
    data: {
      attributes: {
        patron_status: opts.status,
        currently_entitled_amount_cents: opts.cents,
      },
      relationships: {
        user: { data: { id: 'hook-patron' } },
        campaign: { data: { id: 'hook-campaign' } },
        currently_entitled_tiers: { data: (opts.tiers ?? []).map((id) => ({ id })) },
      },
    },
  });

  it('rejects an unsigned request', async () => {
    await request(ctx.app.getHttpServer())
      .post('/webhooks/patreon')
      .set('X-Patreon-Event', 'members:pledge:create')
      .send(pledge({ status: 'active_patron', cents: 1000 }))
      .expect(401);
  });

  it('rejects a request signed with the wrong secret', async () => {
    const raw = JSON.stringify(pledge({ status: 'active_patron', cents: 1000 }));
    const signature = createHmac('md5', 'not-the-secret').update(Buffer.from(raw)).digest('hex');
    await request(ctx.app.getHttpServer())
      .post('/webhooks/patreon')
      .set('X-Patreon-Event', 'members:pledge:create')
      .set('X-Patreon-Signature', signature)
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(401);
  });

  it('is exempt from CSRF, which would otherwise 403 every event', async () => {
    // No pp_csrf cookie and no x-csrf-token header anywhere in this suite.
    await event('members:pledge:create', pledge({ status: 'active_patron', cents: 1000 })).expect(
      204,
    );
  });

  it('creates a membership from a pledge:create', async () => {
    await event(
      'members:pledge:create',
      pledge({ status: 'active_patron', cents: 1000, tiers: ['h-tier'] }),
    ).expect(204);

    const membership = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    expect(membership.isActivePatron).toBe(true);
    expect(membership.amountCents).toBe(1000);
    expect(membership.currentTierId).toBe(tierId);
  });

  it('applies a pledge:update', async () => {
    await event('members:pledge:update', pledge({ status: 'active_patron', cents: 2500 })).expect(
      204,
    );
    const membership = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    expect(membership.amountCents).toBe(2500);
  });

  it('deactivates on a pledge:delete', async () => {
    await event('members:pledge:delete', pledge({ status: 'former_patron', cents: 0 })).expect(204);
    const membership = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    expect(membership.isActivePatron).toBe(false);
    expect(membership.currentTierId).toBeNull();
  });

  it('is idempotent under a replayed event', async () => {
    const send = () =>
      event('members:pledge:update', pledge({ status: 'active_patron', cents: 700 }));
    await send().expect(204);
    await send().expect(204);
    const memberships = await ctx.prisma.membership.findMany({ where: { userId, creatorId } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].amountCents).toBe(700);
  });

  it('does not revoke a membership to another creator', async () => {
    const other = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'hook-other-campaign',
        ownerUserId: (
          await ctx.prisma.user.findUniqueOrThrow({
            where: { patreonUserId: 'hook-owner' },
          })
        ).id,
        displayName: 'Hook Other',
        slug: 'hook-other',
        policy: { create: {} },
      },
    });
    await ctx.prisma.membership.upsert({
      where: { userId_creatorId: { userId, creatorId: other.id } },
      create: { userId, creatorId: other.id, amountCents: 900, isActivePatron: true },
      update: { isActivePatron: true },
    });

    // A delete speaks only for its own campaign.
    await event('members:pledge:delete', pledge({ status: 'former_patron', cents: 0 })).expect(204);

    const untouched = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId: other.id } },
    });
    expect(untouched.isActivePatron).toBe(true);
  });

  it('accepts an event for an unclaimed campaign without creating anything', async () => {
    const before = await ctx.prisma.membership.count();
    // 204 rather than 404: Patreon retries failures, and this will never start succeeding.
    await event('members:pledge:create', {
      data: {
        attributes: { patron_status: 'active_patron', currently_entitled_amount_cents: 100 },
        relationships: {
          user: { data: { id: 'hook-patron' } },
          campaign: { data: { id: 'nobody-claimed-this' } },
          currently_entitled_tiers: { data: [] },
        },
      },
    }).expect(204);
    expect(await ctx.prisma.membership.count()).toBe(before);
  });

  it('accepts an event for a user we have never seen', async () => {
    await event('members:pledge:create', {
      data: {
        attributes: { patron_status: 'active_patron', currently_entitled_amount_cents: 100 },
        relationships: {
          user: { data: { id: 'never-logged-in' } },
          campaign: { data: { id: 'hook-campaign' } },
          currently_entitled_tiers: { data: [] },
        },
      },
    }).expect(204);
    // Nothing to attach to until they log in; login re-sync picks it up then.
    expect(await ctx.prisma.user.count({ where: { patreonUserId: 'never-logged-in' } })).toBe(0);
  });

  it('ignores an event type it does not handle', async () => {
    await event('posts:publish', { data: { id: 'post-1' } }).expect(204);
  });

  it('discards a malformed payload without erroring', async () => {
    await event('members:pledge:create', { data: {} }).expect(204);
  });
});
