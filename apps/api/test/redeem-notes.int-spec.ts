import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

/**
 * Who may read what a token was spent on.
 *
 * The note is the instruction, not a comment on one: nothing here models an episode, so "the
 * next one" exists only as a sentence somebody wrote. A creator who cannot read it has a
 * Priority marker and no way to learn what it asks for — which is the state this file exists to
 * prevent regressing to.
 *
 * The other half is that a note is a stranger's words: staff act on them, so staff read all of
 * them; everybody else reads only their own.
 */
describe('Redeem notes (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let entryId: string;
  let owner: Auth;
  let cal: Auth;
  let bea: Auth;

  type Auth = { session: string; csrf: string; userId: string };

  beforeAll(async () => {
    ctx = await startAuthApp();
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  async function loginAs(patreonUserId: string): Promise<Auth> {
    ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId, memberships: [] };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    const res = await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    const user = await ctx.prisma.user.findFirstOrThrow({ where: { patreonUserId } });
    return {
      session: pickCookie(res, 'pp_session'),
      csrf: pickCookie(res, 'pp_csrf').split(';')[0],
      userId: user.id,
    };
  }

  beforeEach(async () => {
    await ctx.prisma.creatorStaff.deleteMany();
    await ctx.prisma.redeem.deleteMany();
    await ctx.prisma.tokenLedger.deleteMany();
    await ctx.prisma.tokenBalance.deleteMany();
    await ctx.prisma.recommendation.deleteMany();
    await ctx.prisma.creatorPolicy.deleteMany();
    await ctx.prisma.creator.deleteMany();
    await ctx.prisma.user.deleteMany();

    owner = await loginAs('note-owner');
    cal = await loginAs('note-cal');
    bea = await loginAs('note-bea');

    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'note-campaign',
          ownerUserId: owner.userId,
          displayName: 'Notes Co',
          slug: 'notes-co',
          policy: { create: { viewVisibility: 'PUBLIC', redeemTokensEnabled: true } },
          staff: { create: { userId: owner.userId, role: 'OWNER' } },
        },
      })
    ).id;

    entryId = (
      await ctx.prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: bea.userId,
          type: 'EXTERNAL_LINK',
          customTitle: 'Cowboy Bebop',
          normalizedTitle: 'cowboy bebop',
          status: 'ACCEPTED',
          unconsumedRedeems: 2,
        },
      })
    ).id;

    // Written directly: this file is about who may *read* a note. Spending has its own suite.
    await ctx.prisma.redeem.createMany({
      data: [
        { creatorId, recommendationId: entryId, userId: cal.userId, note: 'Session 5' },
        { creatorId, recommendationId: entryId, userId: bea.userId, note: 'The Real Folk Blues' },
      ],
    });
  });

  const board = (who?: Auth) => {
    const call = request(ctx.app.getHttpServer()).get(
      '/api/v1/creators/notes-co/recommendations?status=ACCEPTED',
    );
    return who ? call.set('Cookie', [who.session, who.csrf]) : call;
  };

  const notesFrom = (body: { items: Array<{ redeems?: Array<{ note: string }> }> }) =>
    (body.items[0].redeems ?? []).map((redeem) => redeem.note).sort();

  it('gives the creator every note, and who left it', async () => {
    const res = await board(owner).expect(200);

    expect(notesFrom(res.body)).toEqual(['Session 5', 'The Real Folk Blues']);
    const names = (res.body.items[0].redeems as Array<{ user: { id: string } }>).map(
      (redeem) => redeem.user.id,
    );
    expect(names.sort()).toEqual([bea.userId, cal.userId].sort());
  });

  it("gives a patron their own note and nobody else's", async () => {
    const res = await board(cal).expect(200);

    expect(notesFrom(res.body)).toEqual(['Session 5']);
  });

  it('gives a signed-out reader none at all', async () => {
    // The count is public — the marker is on the card for everyone. The words are not.
    const res = await board().expect(200);

    expect(res.body.items[0].redeems ?? []).toEqual([]);
    expect(res.body.items[0].unconsumedRedeems).toBe(2);
  });

  it('still serves the whole board to a signed-out visitor', async () => {
    // Regression, and the worst kind: the filter that hides other people's notes was written
    // with a sentinel id of `''`, which is not a UUID. Prisma raised P2023, the exception filter
    // turned it into a 404, and a public board with tokens on returned nothing at all to anybody
    // signed out. The notes assertion above passes either way — only this one fails.
    const res = await board().expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].customTitle).toBe('Cowboy Bebop');
  });

  it("never leaks the spender's email or Patreon id", async () => {
    // The redeem carries a User relation, and selecting the row wholesale would put an email
    // address on a board — the same trap `submittedBy` documents one projection over.
    const res = await board(owner).expect(200);

    const [redeem] = res.body.items[0].redeems as Array<{ user: Record<string, unknown> }>;
    expect(Object.keys(redeem.user).sort()).toEqual(['avatarUrl', 'fullName', 'id']);
  });

  it('drops a note once the entry has played', async () => {
    // A consumed redeem describes something already done. Left on the card it reads as an
    // outstanding request for ever.
    await ctx.prisma.redeem.updateMany({ where: { creatorId }, data: { consumedAt: new Date() } });
    await ctx.prisma.recommendation.update({
      where: { id: entryId },
      data: { unconsumedRedeems: 0 },
    });

    const res = await board(owner).expect(200);

    expect(res.body.items[0].redeems ?? []).toEqual([]);
  });
});
