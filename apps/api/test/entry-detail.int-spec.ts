import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';
import { ALL_STAFF_PERMISSIONS } from '../src/access/permissions';

describe('Entry detail (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let otherCreatorId: string;
  let patron: Auth;
  let patronUserId: string;
  let author: Auth;
  let authorUserId: string;
  let staff: Auth;
  let ids: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'ed-owner' } });
    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'ed-campaign',
          ownerUserId: owner.id,
          displayName: 'Detail Co',
          slug: 'detail-co',
          policy: { create: { viewVisibility: 'PUBLIC' } },
          staff: { create: { userId: owner.id, role: 'OWNER' } },
        },
      })
    ).id;
    otherCreatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'ed-other',
          ownerUserId: owner.id,
          displayName: 'Other Co',
          slug: 'ed-other',
          policy: { create: { viewVisibility: 'PUBLIC' } },
        },
      })
    ).id;

    patron = await loginAs('ed-patron');
    patronUserId = await userId('ed-patron');
    author = await loginAs('ed-author');
    authorUserId = await userId('ed-author');
    for (const id of [patronUserId, authorUserId]) {
      await ctx.prisma.membership.create({
        data: { userId: id, creatorId, amountCents: 500, isActivePatron: true },
      });
    }
    staff = await loginAs('ed-staff');
    await ctx.prisma.creatorStaff.create({
      data: {
        creatorId,
        userId: await userId('ed-staff'),
        role: 'MOD',
        permissions: ALL_STAFF_PERMISSIONS,
      },
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.recommendation.deleteMany();
    for (const [key, status, by] of [
      ['visible', 'ACCEPTED', authorUserId],
      ['rejected', 'REJECTED', authorUserId],
      ['deleted', 'DELETED', authorUserId],
      ['pendingByAuthor', 'PENDING', authorUserId],
    ] as const) {
      ids[key] = (
        await ctx.prisma.recommendation.create({
          data: {
            creatorId,
            submittedByUserId: by,
            type: 'EXTERNAL_LINK',
            customTitle: `Entry ${key}`,
            normalizedTitle: `entry ${key}`,
            description: 'Why this one',
            status,
          },
        })
      ).id;
    }
    ids.foreign = (
      await ctx.prisma.recommendation.create({
        data: {
          creatorId: otherCreatorId,
          submittedByUserId: authorUserId,
          type: 'EXTERNAL_LINK',
          customTitle: 'Someone else board',
          normalizedTitle: 'someone else board',
          status: 'ACCEPTED',
        },
      })
    ).id;
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
    return { session: pickCookie(res, 'pp_session'), csrf };
  }

  type Auth = Awaited<ReturnType<typeof loginAs>>;

  const get = (id: string, auth?: Auth, slug = 'detail-co') => {
    const req = request(ctx.app.getHttpServer()).get(
      `/api/v1/creators/${slug}/recommendations/${id}`,
    );
    return auth ? req.set('Cookie', [auth.session, auth.csrf]) : req;
  };

  it('returns the entry with what the board card does not carry', async () => {
    const res = await get(ids.visible, patron).expect(200);

    expect(res.body).toMatchObject({
      id: ids.visible,
      customTitle: 'Entry visible',
      description: 'Why this one',
      status: 'ACCEPTED',
    });
    expect(res.body.submittedBy).toMatchObject({ fullName: expect.any(String) });
  });

  it('serves a signed-out reader on a public board', async () => {
    const res = await get(ids.visible).expect(200);

    expect(res.body.id).toBe(ids.visible);
  });

  it('never leaks the submitter email or Patreon id', async () => {
    const res = await get(ids.visible, patron).expect(200);

    expect(JSON.stringify(res.body)).not.toMatch(/@|patreonUserId/);
  });

  describe('visibility', () => {
    it('hides a rejected entry from a patron', async () => {
      await get(ids.rejected, patron).expect(404);
    });

    it('hides a deleted entry from a patron', async () => {
      await get(ids.deleted, patron).expect(404);
    });

    it('shows a rejected entry to staff, who work the queue', async () => {
      await get(ids.rejected, staff).expect(200);
    });

    it('404s an entry on another board, even a visible one', async () => {
      // The id is real and the entry is public on its own board — but not on this one, and the
      // slug in the path is what decides which board the reader asked about.
      await get(ids.foreign, patron).expect(404);
    });

    it('404s an unknown id', async () => {
      await get('11111111-1111-4111-8111-111111111111', patron).expect(404);
    });

    it('400s an id that is not a uuid', async () => {
      await get('not-a-uuid', patron).expect(400);
    });

    describe('when the board hides pending entries', () => {
      beforeEach(async () => {
        await ctx.prisma.creatorPolicy.update({
          where: { creatorId },
          data: { hidePendingFromPublic: true },
        });
      });

      afterEach(async () => {
        await ctx.prisma.creatorPolicy.update({
          where: { creatorId },
          data: { hidePendingFromPublic: false },
        });
      });

      it('hides another patron pending entry', async () => {
        await get(ids.pendingByAuthor, patron).expect(404);
      });

      it('still shows submitters their own', async () => {
        // Otherwise the submit form looks broken: success, then a link that 404s.
        await get(ids.pendingByAuthor, author).expect(200);
      });
    });
  });

  it('reports whether the reader has upvoted it', async () => {
    await ctx.prisma.upvote.create({
      data: { recommendationId: ids.visible, userId: patronUserId },
    });

    expect((await get(ids.visible, patron).expect(200)).body.hasUpvoted).toBe(true);
    expect((await get(ids.visible, author).expect(200)).body.hasUpvoted).toBe(false);
  });

  it('carries the notes a reader is allowed to see', async () => {
    await ctx.prisma.creatorNote.create({
      data: {
        recommendationId: ids.visible,
        authorUserId: patronUserId,
        body: 'Airing Friday',
        kind: 'TIMELINE',
      },
    });
    await ctx.prisma.creatorNote.create({
      data: {
        recommendationId: ids.visible,
        authorUserId: patronUserId,
        body: 'Internal chatter',
        kind: 'NOTE',
      },
    });

    const res = await get(ids.visible, patron).expect(200);

    // Only the timeline kind reaches the board; commentary is staff-only.
    expect(res.body.notes.map((note: { body: string }) => note.body)).toEqual(['Airing Friday']);
  });
});
