import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

/**
 * A board whose creator switched redeem tokens **off** after using them.
 *
 * The spec's promise is that disabling retains everything and makes it invisible — balances,
 * ledger rows and redeems survive, and reappear unchanged if the creator turns it back on. The
 * "unspendable" half was always true: `grantDue`, `spend` and `balanceFor` each check the policy.
 * The "invisible" half was not, and nothing tested it: all three "feature off" tests cover the
 * token *service*, and none covers the board read.
 *
 * So a creator who tried the feature and switched it off kept showing Priority badges and their
 * patrons' notes to everyone, on a board whose settings say the feature is off.
 */
describe('A board with redeem tokens switched off (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let owner: Auth;
  let cal: Auth;
  let redeemedId: string;
  let plainId: string;

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

    owner = await loginAs('off-owner');
    cal = await loginAs('off-cal');

    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'off-campaign',
          ownerUserId: owner.userId,
          displayName: 'Switched Off Co',
          slug: 'switched-off-co',
          // Enabled to begin with: the whole point is a board that *used* the feature.
          policy: { create: { viewVisibility: 'PUBLIC', redeemTokensEnabled: true } },
          staff: { create: { userId: owner.userId, role: 'OWNER' } },
        },
      })
    ).id;

    const entry = (title: string, weightedScore: number, unconsumedRedeems: number) =>
      ctx.prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: cal.userId,
          type: 'EXTERNAL_LINK',
          customTitle: title,
          normalizedTitle: title.toLowerCase(),
          status: 'ACCEPTED',
          weightedScore,
          unconsumedRedeems,
        },
      });

    // The weaker entry carries the redeem, so redeem-ordering and score-ordering disagree. With
    // them agreeing, "ordered as if the feature were absent" is unobservable.
    redeemedId = (await entry('Redeemed One', 1, 1)).id;
    plainId = (await entry('Higher Scoring', 9, 0)).id;

    await ctx.prisma.redeem.create({
      data: { creatorId, recommendationId: redeemedId, userId: cal.userId, note: 'Session 5' },
    });
    await ctx.prisma.tokenBalance.create({ data: { creatorId, userId: cal.userId, available: 4 } });
    await ctx.prisma.tokenLedger.create({
      data: { creatorId, userId: cal.userId, kind: 'CREATOR_GRANT', amount: 4, reason: 'seed' },
    });
  });

  const disable = () =>
    ctx.prisma.creatorPolicy.update({
      where: { creatorId },
      data: { redeemTokensEnabled: false },
    });

  const board = (who?: Auth) => {
    const call = request(ctx.app.getHttpServer()).get(
      '/api/v1/creators/switched-off-co/recommendations?status=ACCEPTED',
    );
    return who ? call.set('Cookie', [who.session, who.csrf]) : call;
  };

  type Item = { id: string; customTitle: string; unconsumedRedeems: number; redeems?: unknown[] };

  it('shows the marker and the notes while the feature is on', async () => {
    // The control. Without it, every assertion below passes on a board where the feature simply
    // never worked.
    const res = await board(owner).expect(200);
    const items = res.body.items as Item[];

    expect(items[0].customTitle).toBe('Redeemed One');
    expect(items[0].unconsumedRedeems).toBe(1);
    expect(items[0].redeems).toHaveLength(1);
  });

  it('hides the Priority count once the feature is off', async () => {
    await disable();

    const res = await board(owner).expect(200);
    const redeemed = (res.body.items as Item[]).find((i) => i.id === redeemedId);

    expect(redeemed?.unconsumedRedeems).toBe(0);
  });

  it("hides the patrons' notes once the feature is off", async () => {
    // These are readers' own words, shown to a creator for a feature they have turned off.
    await disable();

    const res = await board(owner).expect(200);
    const redeemed = (res.body.items as Item[]).find((i) => i.id === redeemedId);

    expect(redeemed?.redeems ?? []).toEqual([]);
  });

  it('orders the column as though the feature had never existed', async () => {
    // The half that is invisible until it is wrong: a disabled board silently keeping a
    // redeem-first order is a column nobody can explain from the settings page.
    await disable();

    const res = await board(owner).expect(200);

    expect((res.body.items as Item[]).map((i) => i.id)).toEqual([plainId, redeemedId]);
  });

  it('keeps everything, so turning it back on restores what was there', async () => {
    await disable();
    await ctx.prisma.creatorPolicy.update({
      where: { creatorId },
      data: { redeemTokensEnabled: true },
    });

    const res = await board(owner).expect(200);
    const items = res.body.items as Item[];

    expect(items[0].customTitle).toBe('Redeemed One');
    expect(items[0].unconsumedRedeems).toBe(1);
    expect(items[0].redeems).toHaveLength(1);
    expect(await ctx.prisma.redeem.count({ where: { creatorId } })).toBe(1);
    expect(await ctx.prisma.tokenLedger.count({ where: { creatorId } })).toBe(1);
  });

  it('pages a disabled board without dropping or repeating anything', async () => {
    // The hazard this module's own header names: an ordering and a keyset that disagree page
    // silently wrong — rows vanish or repeat and every individual page still looks correct.
    // Gating the ordering on the policy and forgetting the cursor does exactly that, and no
    // other test here can see it, because they all fit on one page.
    //
    // Redeem counts descend as weightedScore ascends, so a cursor that still compares redeems
    // walks the column in a different order from the one the rows came back in.
    await ctx.prisma.recommendation.deleteMany({ where: { creatorId } });
    const wanted: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const row = await ctx.prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: cal.userId,
          type: 'EXTERNAL_LINK',
          customTitle: `Entry ${i}`,
          normalizedTitle: `entry ${i}`,
          status: 'ACCEPTED',
          weightedScore: i,
          unconsumedRedeems: 7 - i,
        },
      });
      wanted.push(row.id);
    }
    // Highest score first, which is how a board with no token feature orders.
    wanted.reverse();
    await disable();

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const url =
        '/api/v1/creators/switched-off-co/recommendations?status=ACCEPTED&limit=2' +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const res = await request(ctx.app.getHttpServer())
        .get(url)
        .set('Cookie', [owner.session, owner.csrf])
        .expect(200);
      seen.push(...(res.body.items as Item[]).map((i) => i.id));
      cursor = res.body.nextCursor ?? undefined;
      if (!cursor) break;
    }

    expect(seen).toEqual(wanted);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('still serves the board to a signed-out visitor with the feature off', async () => {
    // The same trap as the note filter: a clause meant to hide a field taking the page down.
    await disable();

    const res = await board().expect(200);

    expect(res.body.items).toHaveLength(2);
  });
});
