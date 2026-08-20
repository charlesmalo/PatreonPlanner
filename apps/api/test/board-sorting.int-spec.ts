import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Board sorting (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let patron: Auth;
  let staff: Auth;
  let ids: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'bs-owner' } });
    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'bs-campaign',
          ownerUserId: owner.id,
          displayName: 'Sort Co',
          slug: 'sort-co',
          policy: { create: {} },
          staff: { create: { userId: owner.id, role: 'OWNER' } },
        },
      })
    ).id;
    patron = await loginAs('bs-patron');
    await ctx.prisma.membership.create({
      data: {
        userId: await userId('bs-patron'),
        creatorId,
        amountCents: 500,
        isActivePatron: true,
      },
    });
    staff = await loginAs('bs-staff');
    await ctx.prisma.creatorStaff.create({
      data: { creatorId, userId: await userId('bs-staff'), role: 'MOD' },
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.recommendation.deleteMany();
    // Deliberately opposed: newest has the fewest upvotes, so every sort produces a different
    // order and no test can pass by accident.
    const spec = [
      ['oldestMostVotes', 'Oldest', 5, new Date('2026-01-01T00:00:00Z')],
      ['middle', 'Middle', 3, new Date('2026-02-01T00:00:00Z')],
      ['newestFewestVotes', 'Newest', 1, new Date('2026-03-01T00:00:00Z')],
    ] as const;
    for (const [key, title, upvoteCount, createdAt] of spec) {
      ids[key] = (
        await ctx.prisma.recommendation.create({
          data: {
            creatorId,
            submittedByUserId: await userId('bs-patron'),
            type: 'EXTERNAL_LINK',
            customTitle: title,
            normalizedTitle: title.toLowerCase(),
            status: 'PENDING',
            upvoteCount,
            createdAt,
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

  const board = (query: string, auth: Auth = patron) =>
    request(ctx.app.getHttpServer())
      .get(`/api/v1/creators/sort-co/recommendations${query}`)
      .set('Cookie', [auth.session, auth.csrf]);

  const pick = (id: string, auth: Auth, on = true) =>
    request(ctx.app.getHttpServer())
      [on ? 'post' : 'delete'](`/api/v1/creators/sort-co/recommendations/${id}/pick`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken);

  const titles = (body: { items: Array<{ customTitle: string }> }) =>
    body.items.map((i) => i.customTitle);

  it('sorts by upvotes when not asked otherwise', async () => {
    expect(titles((await board('').expect(200)).body)).toEqual(['Oldest', 'Middle', 'Newest']);
  });

  it('sorts newest first when asked', async () => {
    expect(titles((await board('?sort=newest').expect(200)).body)).toEqual([
      'Newest',
      'Middle',
      'Oldest',
    ]);
  });

  it('sorts oldest first when asked', async () => {
    expect(titles((await board('?sort=oldest').expect(200)).body)).toEqual([
      'Oldest',
      'Middle',
      'Newest',
    ]);
  });

  it('rejects a sort it does not have', async () => {
    await board('?sort=sideways').expect(400);
  });

  describe('paging', () => {
    it('does not repeat or skip a row when paging by newest', async () => {
      const first = await board('?sort=newest&limit=2').expect(200);
      const second = await board(`?sort=newest&limit=2&cursor=${first.body.nextCursor}`).expect(
        200,
      );

      expect(titles(first.body)).toEqual(['Newest', 'Middle']);
      expect(titles(second.body)).toEqual(['Oldest']);
    });

    it('does not repeat or skip a row when paging by oldest', async () => {
      // The comparison flips with the ordering; a keyset built for one direction silently pages
      // the wrong way in the other.
      const first = await board('?sort=oldest&limit=2').expect(200);
      const second = await board(`?sort=oldest&limit=2&cursor=${first.body.nextCursor}`).expect(
        200,
      );

      expect(titles(first.body)).toEqual(['Oldest', 'Middle']);
      expect(titles(second.body)).toEqual(['Newest']);
    });
  });

  describe("the creator's own picks", () => {
    it('floats a pick above everything, whatever the sort', async () => {
      await pick(ids.newestFewestVotes, staff).expect(204);

      expect(titles((await board('').expect(200)).body)[0]).toBe('Newest');
      expect(titles((await board('?sort=oldest').expect(200)).body)[0]).toBe('Newest');
    });

    it('keeps the rest in their usual order beneath', async () => {
      await pick(ids.newestFewestVotes, staff).expect(204);

      expect(titles((await board('').expect(200)).body)).toEqual(['Newest', 'Oldest', 'Middle']);
    });

    it('pages correctly with a pick at the top', async () => {
      await pick(ids.newestFewestVotes, staff).expect(204);

      const first = await board('?limit=1').expect(200);
      const second = await board(`?limit=1&cursor=${first.body.nextCursor}`).expect(200);

      expect(titles(first.body)).toEqual(['Newest']);
      expect(titles(second.body)).toEqual(['Oldest']);
    });

    it('can be taken back', async () => {
      await pick(ids.newestFewestVotes, staff).expect(204);
      await pick(ids.newestFewestVotes, staff, false).expect(204);

      expect(titles((await board('').expect(200)).body)[0]).toBe('Oldest');
    });

    it('says which entries are picks, so the board can show why', async () => {
      await pick(ids.middle, staff).expect(204);

      const entry = (await board('').expect(200)).body.items.find(
        (i: { customTitle: string }) => i.customTitle === 'Middle',
      );
      expect(entry.isCreatorPick).toBe(true);
    });

    it('refuses a pick from a patron', async () => {
      await pick(ids.middle, patron).expect(403);
    });

    it('404s an entry on another board', async () => {
      const other = await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'bs-other',
          ownerUserId: await userId('bs-owner'),
          displayName: 'Other',
          slug: 'bs-other',
          policy: { create: {} },
        },
      });
      const foreign = await ctx.prisma.recommendation.create({
        data: {
          creatorId: other.id,
          submittedByUserId: await userId('bs-patron'),
          type: 'EXTERNAL_LINK',
          customTitle: 'Elsewhere',
          normalizedTitle: 'elsewhere',
        },
      });

      await pick(foreign.id, staff).expect(404);

      await ctx.prisma.creator.delete({ where: { id: other.id } });
    });
  });
});
