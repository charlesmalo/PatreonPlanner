import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Creator read and policy endpoints (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let tierIds: { lo: string; hi: string };

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'policy-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'policy-campaign',
        ownerUserId: owner.id,
        displayName: 'Policy Co',
        slug: 'policy-co',
        baseUrl: 'https://policy.example.com',
        tiers: {
          create: [
            { patreonTierId: 'p-lo', title: 'Bronze', amountCents: 300, order: 0 },
            { patreonTierId: 'p-hi', title: 'Gold', amountCents: 1000, order: 1 },
          ],
        },
        policy: { create: { viewVisibility: 'PUBLIC' } },
      },
      include: { tiers: true },
    });
    creatorId = creator.id;
    tierIds = {
      lo: creator.tiers.find((t) => t.amountCents === 300)!.id,
      hi: creator.tiers.find((t) => t.amountCents === 1000)!.id,
    };
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  async function loginAs(patreonUserId: string) {
    ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId, memberships: [] };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    const res = await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    const csrf = pickCookie(res, 'pp_csrf').split(';')[0];
    return {
      session: pickCookie(res, 'pp_session'),
      csrf,
      csrfToken: csrf.split('=').slice(1).join('='),
    };
  }

  async function makeStaff(patreonUserId: string) {
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId } });
    await ctx.prisma.creatorStaff.upsert({
      where: { creatorId_userId: { creatorId, userId: user.id } },
      create: { creatorId, userId: user.id, role: 'OWNER' },
      update: {},
    });
  }

  it('exposes the public creator profile without a login', async () => {
    // Said out loud rather than inherited. Boards are subscribers-only by default now, so a test
    // about what an anonymous reader sees has to open the board first — otherwise it is testing
    // the default, and it would pass or fail on a decision made somewhere else entirely.
    await ctx.prisma.creatorPolicy.update({
      where: { creatorId },
      data: { viewVisibility: 'PUBLIC' },
    });

    const res = await request(ctx.app.getHttpServer())
      .get('/api/v1/creators/policy-co')
      .expect(200);
    expect(res.body).toEqual({
      id: creatorId,
      slug: 'policy-co',
      displayName: 'Policy Co',
      baseUrl: 'https://policy.example.com',
      tiers: [
        // `voteWeight` travels with the tier: it is how this board counts a vote, and a patron can
        // already read it for their own tier on the my-votes page. Nothing is disclosed by saying
        // it beside the price, and the settings page needs it to show what it is editing.
        {
          id: tierIds.lo,
          title: 'Bronze',
          amountCents: 300,
          order: 0,
          voteWeight: 1,
          tokensPerPeriod: 0,
        },
        {
          id: tierIds.hi,
          title: 'Gold',
          amountCents: 1000,
          order: 1,
          voteWeight: 1,
          tokensPerPeriod: 0,
        },
      ],
    });
  });

  it('never exposes the owner or the patreon campaign id publicly', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/creators/policy-co');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('ownerUserId');
    expect(body).not.toContain('policy-campaign');
  });

  it('refuses policy reads to a non-staff user', async () => {
    const auth = await loginAs('policy-stranger');
    await request(ctx.app.getHttpServer())
      .get(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', auth.session)
      .expect(403);
  });

  it('lets staff read the policy', async () => {
    const auth = await loginAs('policy-staff');
    await makeStaff('policy-staff');
    const res = await request(ctx.app.getHttpServer())
      .get(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', auth.session)
      .expect(200);
    // Whatever the previous test left, not a hardcoded guess: this is about staff being allowed
    // to read the policy at all, not about which visibility it happens to hold.
    const stored = await ctx.prisma.creatorPolicy.findUniqueOrThrow({ where: { creatorId } });
    expect(res.body.viewVisibility).toBe(stored.viewVisibility);
    // Every setting a creator decides comes back, including the four that the API held and never
    // exposed until the settings page needed them.
    expect(res.body).toMatchObject({
      allowAnonymousTickets: expect.any(Boolean),
      allowReactions: expect.any(Boolean),
      acceptsCarryOver: expect.any(Boolean),
      allowVoteRatchet: expect.any(Boolean),
    });
  });

  it('lets staff update the policy', async () => {
    const auth = await loginAs('policy-staff-2');
    await makeStaff('policy-staff-2');
    try {
      const res = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/creators/${creatorId}/policy`)
        .set('Cookie', [auth.session, auth.csrf])
        .set('x-csrf-token', auth.csrfToken)
        .send({ viewVisibility: 'SUBSCRIBERS_ONLY', submitMinTierId: tierIds.hi })
        .expect(200);
      expect(res.body.viewVisibility).toBe('SUBSCRIBERS_ONLY');
      expect(res.body.submitMinTierId).toBe(tierIds.hi);
    } finally {
      // In a finally: a failure here would otherwise leave the shared fixture gated and cascade
      // into misleading failures downstream.
      await ctx.prisma.creatorPolicy.update({
        where: { creatorId },
        data: { viewVisibility: 'PUBLIC', submitMinTierId: null },
      });
    }
  });

  it('rejects a policy update without a csrf token', async () => {
    const auth = await loginAs('policy-staff-3');
    await makeStaff('policy-staff-3');
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', auth.session)
      .send({ viewVisibility: 'PUBLIC' })
      .expect(403);
  });

  it('rejects an unknown visibility value', async () => {
    const auth = await loginAs('policy-staff-5');
    await makeStaff('policy-staff-5');
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ viewVisibility: 'EVERYONE' })
      .expect(400);
  });

  it('rejects an explicit null on a non-nullable policy field', async () => {
    const auth = await loginAs('policy-staff-6');
    await makeStaff('policy-staff-6');
    // @IsOptional() waves null through, so this reached Prisma and surfaced as a 500.
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ viewVisibility: null })
      .expect(400);
  });

  it('clears a gate when a tier id is explicitly null', async () => {
    const auth = await loginAs('policy-staff-7');
    await makeStaff('policy-staff-7');
    const res = await request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ submitMinTierId: null })
      .expect(200);
    expect(res.body.submitMinTierId).toBeNull();
  });

  it('lets staff register a webhook secret without echoing it back', async () => {
    const auth = await loginAs('policy-staff-8');
    await makeStaff('policy-staff-8');
    const res = await request(ctx.app.getHttpServer())
      .put(`/api/v1/creators/${creatorId}/webhook-secret`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ secret: 'the-patreon-webhook-secret' })
      .expect(200);
    expect(JSON.stringify(res.body)).not.toContain('the-patreon-webhook-secret');

    const creator = await ctx.prisma.creator.findUniqueOrThrow({ where: { id: creatorId } });
    // Encrypted at rest like the OAuth tokens.
    expect(creator.webhookSecretEncrypted).toContain('v1:');
    expect(creator.webhookSecretEncrypted).not.toContain('the-patreon-webhook-secret');
  });

  it('refuses a webhook secret from a non-staff user', async () => {
    const auth = await loginAs('policy-outsider');
    await request(ctx.app.getHttpServer())
      .put(`/api/v1/creators/${creatorId}/webhook-secret`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ secret: 'nope' })
      .expect(403);
  });

  it('refuses a tier belonging to another creator', async () => {
    const auth = await loginAs('policy-staff-4');
    await makeStaff('policy-staff-4');
    const stranger = await ctx.prisma.user.create({ data: { patreonUserId: 'tier-thief' } });
    const otherCreator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'thief-campaign',
        ownerUserId: stranger.id,
        displayName: 'Thief',
        slug: 'thief',
        tiers: { create: [{ patreonTierId: 't-1', title: 'T', amountCents: 100, order: 0 }] },
      },
      include: { tiers: true },
    });
    // Otherwise a creator could gate their board on a tier nobody pledging to them can hold.
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ submitMinTierId: otherCreator.tiers[0].id })
      .expect(400);
  });

  describe('a board is private until its creator opens it', () => {
    /**
     * The default is a security decision. A public board publishes what a creator is currently
     * watching, and those lists are scraped to file fraudulent DMCA claims against them.
     *
     * ANY_PATREON_USER is no defence: a Patreon account is free, so it costs an automated reader
     * nothing. Only SUBSCRIBERS_ONLY puts a price on looking.
     */
    it('starts subscribers-only', async () => {
      const owner = await ctx.prisma.user.create({
        data: { patreonUserId: `default-owner-${Date.now()}` },
      });
      const fresh = await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: `default-campaign-${Date.now()}`,
          ownerUserId: owner.id,
          displayName: 'Fresh Board',
          slug: `fresh-${Date.now()}`,
          // Deliberately unset: this test is about what a board gets when nobody chooses.
          policy: { create: {} },
        },
      });

      const policy = await ctx.prisma.creatorPolicy.findUniqueOrThrow({
        where: { creatorId: fresh.id },
      });
      expect(policy.viewVisibility).toBe('SUBSCRIBERS_ONLY');
    });

    it('leaves a board that already chose public alone', async () => {
      // Changing a default must not rewrite anybody's decision. A creator who chose PUBLIC chose
      // it, and their patrons would arrive at a board that had vanished with no explanation.
      const owner = await ctx.prisma.user.create({
        data: { patreonUserId: `open-owner-${Date.now()}` },
      });
      const open = await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: `open-campaign-${Date.now()}`,
          ownerUserId: owner.id,
          displayName: 'Open Board',
          slug: `open-${Date.now()}`,
          policy: { create: { viewVisibility: 'PUBLIC' } },
        },
      });

      const policy = await ctx.prisma.creatorPolicy.findUniqueOrThrow({
        where: { creatorId: open.id },
      });
      expect(policy.viewVisibility).toBe('PUBLIC');
    });
  });

  describe('delegating the settings to a moderator', () => {
    /**
     * Running the queue and deciding who may read the board are different powers. A moderator
     * arriving by invite link holds the first; the second is granted deliberately or not at all.
     */
    const asModerator = async (patreonUserId: string, permissions: string[]) => {
      const auth = await loginAs(patreonUserId);
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId } });
      await ctx.prisma.creatorStaff.upsert({
        where: { creatorId_userId: { creatorId, userId: user.id } },
        create: { creatorId, userId: user.id, role: 'MOD', permissions: permissions as never },
        update: { role: 'MOD', permissions: permissions as never },
      });
      return auth;
    };

    it('refuses a moderator who was not given it', async () => {
      const auth = await asModerator('policy-plain-mod', ['MOVE_ENTRIES']);

      await request(ctx.app.getHttpServer())
        .get(`/api/v1/creators/${creatorId}/policy`)
        .set('Cookie', auth.session)
        .expect(403);
    });

    it('lets a moderator who was read it', async () => {
      const auth = await asModerator('policy-trusted-mod', ['MANAGE_POLICY']);

      await request(ctx.app.getHttpServer())
        .get(`/api/v1/creators/${creatorId}/policy`)
        .set('Cookie', auth.session)
        .expect(200);
    });

    it('lets them change it too', async () => {
      const auth = await asModerator('policy-writing-mod', ['MANAGE_POLICY']);

      await request(ctx.app.getHttpServer())
        .patch(`/api/v1/creators/${creatorId}/policy`)
        .set('Cookie', [auth.session, auth.csrf])
        .set('x-csrf-token', auth.csrfToken)
        .send({ allowReactions: false })
        .expect(200);

      const policy = await ctx.prisma.creatorPolicy.findUniqueOrThrow({ where: { creatorId } });
      expect(policy.allowReactions).toBe(false);
      await ctx.prisma.creatorPolicy.update({
        where: { creatorId },
        data: { allowReactions: true },
      });
    });

    it('still lets the owner, who was granted nothing', async () => {
      // An owner's powers come from the role short-circuiting the permission check. Their stored
      // column is empty by design, and requiring a grant would lock them out of their own board.
      const auth = await loginAs('policy-owner-check');
      await makeStaff('policy-owner-check');

      await request(ctx.app.getHttpServer())
        .get(`/api/v1/creators/${creatorId}/policy`)
        .set('Cookie', auth.session)
        .expect(200);
    });
  });
});
