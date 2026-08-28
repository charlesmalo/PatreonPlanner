import request from 'supertest';
import { FREE_REACTIONS, PREMIUM_REACTIONS, REACTIONS } from '../src/reactions/palette';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Reactions (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let patron: Auth;
  let patronUserId: string;
  let other: Auth;
  let reader: Auth;
  let entryId: string;
  let noteId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'rx-owner' } });
    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'rx-campaign',
          ownerUserId: owner.id,
          displayName: 'React Co',
          slug: 'react-co',
          policy: { create: {} },
          staff: { create: { userId: owner.id, role: 'OWNER' } },
        },
      })
    ).id;

    patron = await loginAs('rx-patron');
    patronUserId = await userId('rx-patron');
    other = await loginAs('rx-other');
    for (const who of ['rx-patron', 'rx-other']) {
      await ctx.prisma.membership.create({
        data: { userId: await userId(who), creatorId, amountCents: 500, isActivePatron: true },
      });
    }
    // Signed in, but not a patron here — may read the public board and may not react.
    reader = await loginAs('rx-reader');
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.reaction.deleteMany();
    await ctx.prisma.creatorNote.deleteMany();
    await ctx.prisma.recommendation.deleteMany();
    await ctx.prisma.creatorPolicy.update({
      where: { creatorId },
      data: { allowReactions: true },
    });
    entryId = (
      await ctx.prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: patronUserId,
          type: 'EXTERNAL_LINK',
          customTitle: 'Akira',
          normalizedTitle: 'akira',
          status: 'PENDING',
        },
      })
    ).id;
    noteId = (
      await ctx.prisma.creatorNote.create({
        data: {
          recommendationId: entryId,
          authorUserId: await userId('rx-owner'),
          body: 'Watch-along on Friday',
          kind: 'TIMELINE',
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
    return {
      session: pickCookie(res, 'pp_session'),
      csrf,
      csrfToken: csrf.split('=').slice(1).join('='),
    };
  }

  type Auth = Awaited<ReturnType<typeof loginAs>>;

  const react = (auth: Auth, body: object, slug = 'react-co') =>
    request(ctx.app.getHttpServer())
      .post(`/api/v1/creators/${slug}/reactions`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  const board = (auth: Auth) =>
    request(ctx.app.getHttpServer())
      .get('/api/v1/creators/react-co/recommendations')
      .set('Cookie', [auth.session, auth.csrf]);

  const first = REACTIONS[0];
  const locked = PREMIUM_REACTIONS[0];

  const setPremium = (patreonUserId: string, until: Date | null) =>
    ctx.prisma.user.update({ where: { patreonUserId }, data: { premiumUntil: until } });

  describe('the premium palette', () => {
    it('refuses a free reader the premium half, and says why', async () => {
      const res = await react(patron, { recommendationId: entryId, emote: locked });

      expect(res.status).toBe(402);
      expect(await ctx.prisma.reaction.count({ where: { emote: locked } })).toBe(0);
    });

    it('lets a premium reader use either half', async () => {
      await setPremium('rx-patron', new Date(Date.now() + 86_400_000));
      try {
        await react(patron, { recommendationId: entryId, emote: locked }).expect(201);
        await react(patron, { recommendationId: entryId, emote: first }).expect(201);
      } finally {
        await setPremium('rx-patron', null);
      }
    });

    it('keeps showing a premium reaction after the subscription lapses', async () => {
      // Reading is never gated. Gating it would make the count vanish the day somebody stopped
      // paying — a lie about the data, and a clawback of something already given.
      await setPremium('rx-patron', new Date(Date.now() + 86_400_000));
      await react(patron, { recommendationId: entryId, emote: locked }).expect(201);
      await setPremium('rx-patron', null);

      const entry = (await board(patron).expect(200)).body.items.find(
        (i: { id: string }) => i.id === entryId,
      );

      expect(entry.reactions).toContainEqual(expect.objectContaining({ emote: locked, count: 1 }));
    });

    it('still refuses a lapsed reader a new one', async () => {
      // The old reaction stands; the next one does not. Lapsing stops future casts rather than
      // undoing past ones.
      await setPremium('rx-patron', new Date(Date.now() - 1000));

      await react(patron, { recommendationId: entryId, emote: locked }).expect(402);
    });
  });

  const second = REACTIONS[1];

  describe('reacting', () => {
    it('records a reaction to an entry', async () => {
      const res = await react(patron, { recommendationId: entryId, emote: first }).expect(201);

      expect(res.body).toMatchObject({ emote: first, count: 1, reacted: true });
    });

    it('takes it back when the same emote is sent again', async () => {
      await react(patron, { recommendationId: entryId, emote: first }).expect(201);

      const res = await react(patron, { recommendationId: entryId, emote: first }).expect(201);

      expect(res.body).toMatchObject({ emote: first, count: 0, reacted: false });
    });

    it('counts two different emotes from the same person separately', async () => {
      await react(patron, { recommendationId: entryId, emote: first }).expect(201);
      const res = await react(patron, { recommendationId: entryId, emote: second }).expect(201);

      expect(res.body).toMatchObject({ emote: second, count: 1 });
      expect(await ctx.prisma.reaction.count({ where: { recommendationId: entryId } })).toBe(2);
    });

    it('counts one emote from two people once each', async () => {
      await react(patron, { recommendationId: entryId, emote: first }).expect(201);

      const res = await react(other, { recommendationId: entryId, emote: first }).expect(201);

      expect(res.body).toMatchObject({ count: 2, reacted: true });
    });

    it('reacts to a note as readily as to an entry', async () => {
      const res = await react(patron, { noteId, emote: first }).expect(201);

      expect(res.body).toMatchObject({ count: 1 });
    });

    it('refuses an emote outside the palette', async () => {
      // The set is one we ship. Anything else is a client sending what it likes.
      await react(patron, { recommendationId: entryId, emote: '💀' }).expect(400);
    });

    it('refuses a request naming neither a subject nor both', async () => {
      await react(patron, { emote: first }).expect(400);
      await react(patron, { recommendationId: entryId, noteId, emote: first }).expect(400);
    });

    it('404s an entry on another board', async () => {
      const elsewhere = await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'rx-other',
          ownerUserId: await userId('rx-owner'),
          displayName: 'Other',
          slug: 'rx-other',
          policy: { create: {} },
        },
      });
      const foreign = await ctx.prisma.recommendation.create({
        data: {
          creatorId: elsewhere.id,
          submittedByUserId: patronUserId,
          type: 'EXTERNAL_LINK',
          customTitle: 'Elsewhere',
          normalizedTitle: 'elsewhere',
        },
      });

      await react(patron, { recommendationId: foreign.id, emote: first }).expect(404);

      await ctx.prisma.creator.delete({ where: { id: elsewhere.id } });
    });

    it('refuses a reader who may not upvote here', async () => {
      // Reacting is participation. A board that gates upvoting gates this too.
      await react(reader, { recommendationId: entryId, emote: first }).expect(403);
    });

    it('refuses when the creator has turned reactions off', async () => {
      await ctx.prisma.creatorPolicy.update({
        where: { creatorId },
        data: { allowReactions: false },
      });

      await react(patron, { recommendationId: entryId, emote: first }).expect(403);
    });

    it('goes when the entry goes', async () => {
      await react(patron, { recommendationId: entryId, emote: first }).expect(201);

      await ctx.prisma.recommendation.delete({ where: { id: entryId } });

      expect(await ctx.prisma.reaction.count()).toBe(0);
    });
  });

  describe('on the board', () => {
    it('carries the counts and what the reader chose', async () => {
      await react(patron, { recommendationId: entryId, emote: first }).expect(201);
      await react(other, { recommendationId: entryId, emote: first }).expect(201);
      await react(other, { recommendationId: entryId, emote: second }).expect(201);

      const res = await board(patron).expect(200);

      const entry = res.body.items.find((i: { id: string }) => i.id === entryId);
      expect(entry.reactions).toEqual(
        expect.arrayContaining([
          { emote: first, count: 2, reacted: true },
          { emote: second, count: 1, reacted: false },
        ]),
      );
    });

    it('never lets a reaction move an entry', async () => {
      // The whole point. If reactions could reorder, they would be a second voting system with
      // none of the tier weighting that makes the first one meaningful — and floodable.
      const quiet = await ctx.prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: patronUserId,
          type: 'EXTERNAL_LINK',
          customTitle: 'Quiet',
          normalizedTitle: 'quiet',
          status: 'PENDING',
          upvoteCount: 1,
          weightedScore: 1,
        },
      });
      // Akira carries every reaction a free reader can cast and no upvotes; Quiet has one upvote
      // and none. The free set rather than the whole palette, so this stays a test about ordering
      // rather than one that fails the day the premium half changes.
      for (const emote of FREE_REACTIONS) {
        await react(patron, { recommendationId: entryId, emote }).expect(201);
        await react(other, { recommendationId: entryId, emote }).expect(201);
      }

      const res = await board(patron).expect(200);

      expect(res.body.items[0].id).toBe(quiet.id);
    });

    it('reports no reactions when the board has them off', async () => {
      await react(patron, { recommendationId: entryId, emote: first }).expect(201);
      await ctx.prisma.creatorPolicy.update({
        where: { creatorId },
        data: { allowReactions: false },
      });

      const res = await board(patron).expect(200);

      const entry = res.body.items.find((i: { id: string }) => i.id === entryId);
      expect(entry.reactions).toEqual([]);
    });
  });
});
