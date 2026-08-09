import { createHmac } from 'node:crypto';
import request from 'supertest';
import { EncryptionService } from '../src/crypto/encryption.service';
import { AuthTestContext, startAuthApp } from './support/auth-app';

const SECRET = 'creator-hook-secret';

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
    // Each creator registers their own Patreon webhook secret; it is stored encrypted.
    await ctx.prisma.creator.update({
      where: { id: creatorId },
      data: {
        webhookSecretEncrypted: ctx.app.get(EncryptionService).encrypt(SECRET),
      },
    });
    const patron = await ctx.prisma.user.create({ data: { patreonUserId: 'hook-patron' } });
    userId = patron.id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  function event(trigger: string, body: object, secret = SECRET, target?: string) {
    const raw = JSON.stringify(body);
    const signature = createHmac('md5', secret).update(Buffer.from(raw)).digest('hex');
    return request(ctx.app.getHttpServer())
      .post(`/webhooks/patreon/${target ?? creatorId}`)
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
      .post(`/webhooks/patreon/${creatorId}`)
      .set('X-Patreon-Event', 'members:pledge:create')
      .send(pledge({ status: 'active_patron', cents: 1000 }))
      .expect(401);
  });

  it('rejects a request signed with the wrong secret', async () => {
    await event(
      'members:pledge:create',
      pledge({ status: 'active_patron', cents: 1000 }),
      'not-the-secret',
    ).expect(401);
  });

  it('rejects a creator that has registered no secret', async () => {
    const owner = await ctx.prisma.user.findUniqueOrThrow({
      where: { patreonUserId: 'hook-owner' },
    });
    const bare = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'bare-campaign',
        ownerUserId: owner.id,
        displayName: 'Bare',
        slug: 'bare',
        policy: { create: {} },
      },
    });
    await event(
      'members:pledge:create',
      pledge({ status: 'active_patron', cents: 1000 }),
      SECRET,
      bare.id,
    ).expect(401);
  });

  it('discards an event naming another creator’s campaign', async () => {
    const owner = await ctx.prisma.user.findUniqueOrThrow({
      where: { patreonUserId: 'hook-owner' },
    });
    const victim = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'victim-campaign',
        ownerUserId: owner.id,
        displayName: 'Victim',
        slug: 'victim',
        policy: { create: {} },
      },
    });
    // Correctly signed for OUR creator, but naming someone else's campaign in the body. The
    // secret proves who sent it, not what they may write about.
    await event('members:pledge:create', {
      data: {
        attributes: { patron_status: 'active_patron', currently_entitled_amount_cents: 9999 },
        relationships: {
          user: { data: { id: 'hook-patron' } },
          campaign: { data: { id: 'victim-campaign' } },
          currently_entitled_tiers: { data: [] },
        },
      },
    }).expect(204);
    expect(await ctx.prisma.membership.count({ where: { creatorId: victim.id } })).toBe(0);
  });

  it('rejects a malformed payload rather than writing zeros over a membership', async () => {
    // attributes present but the wrong type: without validation this wrote amountCents 0.
    await event('members:pledge:update', {
      data: {
        attributes: { currently_entitled_amount_cents: 'lots' },
        relationships: {
          user: { data: { id: 'hook-patron' } },
          campaign: { data: { id: 'hook-campaign' } },
        },
      },
    }).expect(400);
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

  it('discards an event with no attributes rather than revoking', async () => {
    await event('members:pledge:update', pledge({ status: 'active_patron', cents: 4200 })).expect(
      204,
    );
    // An event that validates but carries no attributes says nothing about patron status;
    // treating that as "not a patron" would revoke on a payload change.
    await event('members:pledge:update', {
      data: {
        relationships: {
          user: { data: { id: 'hook-patron' } },
          campaign: { data: { id: 'hook-campaign' } },
        },
      },
    }).expect(204);
    const membership = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    expect(membership.isActivePatron).toBe(true);
    expect(membership.amountCents).toBe(4200);
  });
});
