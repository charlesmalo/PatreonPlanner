import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Manual order (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let mover: Auth;
  let bystander: Auth;
  let patron: Auth;
  let ids: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'mo-owner' } });
    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'mo-campaign',
          ownerUserId: owner.id,
          displayName: 'Order Co',
          slug: 'order-co',
          policy: { create: { viewVisibility: 'PUBLIC' } },
          staff: { create: { userId: owner.id, role: 'OWNER' } },
        },
      })
    ).id;
    mover = await loginAs('mo-mover');
    await ctx.prisma.creatorStaff.create({
      data: {
        creatorId,
        userId: await userId('mo-mover'),
        role: 'MOD',
        permissions: ['MOVE_ENTRIES'],
      },
    });
    bystander = await loginAs('mo-bystander');
    await ctx.prisma.creatorStaff.create({
      data: {
        creatorId,
        userId: await userId('mo-bystander'),
        role: 'MOD',
        permissions: ['WRITE_NOTES'],
      },
    });
    patron = await loginAs('mo-patron');
    await ctx.prisma.membership.create({
      data: {
        userId: await userId('mo-patron'),
        creatorId,
        amountCents: 500,
        isActivePatron: true,
      },
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.recommendation.deleteMany();
    // Ranks deliberately opposed to creation order, so a passing test cannot be an accident of
    // insertion sequence.
    for (const [key, title, rank] of [
      ['first', 'Alpha', 300],
      ['second', 'Beta', 200],
      ['third', 'Gamma', 100],
    ] as const) {
      ids[key] = (
        await ctx.prisma.recommendation.create({
          data: {
            creatorId,
            submittedByUserId: await userId('mo-patron'),
            type: 'EXTERNAL_LINK',
            customTitle: title,
            normalizedTitle: title.toLowerCase(),
            status: 'PENDING',
            manualRank: rank,
          },
        })
      ).id;
    }
  });

  const userId = async (patreonUserId: string) =>
    (await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId } })).id;

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

  type Auth = Awaited<ReturnType<typeof loginAs>>;

  const board = (query = '', auth: Auth = patron) =>
    request(ctx.app.getHttpServer())
      .get(`/api/v1/creators/order-co/recommendations${query}`)
      .set('Cookie', [auth.session, auth.csrf]);

  const rank = (auth: Auth, id: string, body: object) =>
    request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/order-co/recommendations/${id}/rank`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  const titles = (body: { items: Array<{ customTitle: string }> }) =>
    body.items.map((i) => i.customTitle);

  it('orders by the hand-made rank when asked', async () => {
    // Highest first, so "top of the column" is the biggest number and an insert at the top does
    // not need every other row rewritten.
    expect(titles((await board('?sort=manual').expect(200)).body)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
  });

  it('leaves an unranked entry at the bottom, stably', async () => {
    const unranked = await ctx.prisma.recommendation.create({
      data: {
        creatorId,
        submittedByUserId: await userId('mo-patron'),
        type: 'EXTERNAL_LINK',
        customTitle: 'Never Placed',
        normalizedTitle: 'never placed',
        status: 'PENDING',
      },
    });

    const order = titles((await board('?sort=manual').expect(200)).body);

    expect(order[order.length - 1]).toBe('Never Placed');
    expect(unranked.manualRank).toBeNull();
  });

  it('places a card between the two it was dropped between', async () => {
    // Gamma to the middle: between Alpha (300) and Beta (200).
    await rank(mover, ids.third, { afterId: ids.first, beforeId: ids.second }).expect(200);

    expect(titles((await board('?sort=manual').expect(200)).body)).toEqual([
      'Alpha',
      'Gamma',
      'Beta',
    ]);
  });

  it('places a card at the top when nothing is above it', async () => {
    await rank(mover, ids.third, { beforeId: ids.first }).expect(200);

    expect(titles((await board('?sort=manual').expect(200)).body)[0]).toBe('Gamma');
  });

  it('places a card at the bottom when nothing is below it', async () => {
    await rank(mover, ids.first, { afterId: ids.third }).expect(200);

    expect(titles((await board('?sort=manual').expect(200)).body)).toEqual([
      'Beta',
      'Gamma',
      'Alpha',
    ]);
  });

  it('pages by manual rank without repeating or skipping', async () => {
    const page1 = await board('?sort=manual&limit=2').expect(200);
    const page2 = await board(`?sort=manual&limit=2&cursor=${page1.body.nextCursor}`).expect(200);

    expect(titles(page1.body)).toEqual(['Alpha', 'Beta']);
    expect(titles(page2.body)).toEqual(['Gamma']);
  });

  it('leaves the other sorts alone', async () => {
    // Manual is a mode, not a global override: the demand signal is still the default.
    const res = await board('').expect(200);

    expect(titles(res.body)).toHaveLength(3);
  });

  it('refuses a moderator without MOVE_ENTRIES', async () => {
    await rank(bystander, ids.third, { beforeId: ids.first }).expect(403);
  });

  it('refuses a patron', async () => {
    await rank(patron, ids.third, { beforeId: ids.first }).expect(403);
  });

  it('404s an entry on another board', async () => {
    const other = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'mo-other',
        ownerUserId: await userId('mo-owner'),
        displayName: 'Other',
        slug: 'mo-other',
        policy: { create: { viewVisibility: 'PUBLIC' } },
      },
    });
    const foreign = await ctx.prisma.recommendation.create({
      data: {
        creatorId: other.id,
        submittedByUserId: await userId('mo-patron'),
        type: 'EXTERNAL_LINK',
        customTitle: 'Elsewhere',
        normalizedTitle: 'elsewhere',
      },
    });

    await rank(mover, foreign.id, { beforeId: ids.first }).expect(404);
    await rank(mover, ids.first, { beforeId: foreign.id }).expect(404);

    await ctx.prisma.creator.delete({ where: { id: other.id } });
  });
});
