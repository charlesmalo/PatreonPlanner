import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';
import { ALL_STAFF_PERMISSIONS } from '../src/access/permissions';

describe('Board visibility (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let staff: Auth;
  let patron: Auth;
  let otherPatron: Auth;
  let patronUserId: string;
  let pendingId: string;
  let acceptedId: string;
  let rejectedId: string;
  let deletedId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'bv-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'bv-campaign',
        ownerUserId: owner.id,
        displayName: 'Visibility Co',
        slug: 'visibility-co',
        policy: { create: {} },
      },
    });
    creatorId = creator.id;

    staff = await loginAs('bv-staff');
    const staffUser = await ctx.prisma.user.findUniqueOrThrow({
      where: { patreonUserId: 'bv-staff' },
    });
    await ctx.prisma.creatorStaff.create({
      data: { creatorId, userId: staffUser.id, role: 'MOD', permissions: ALL_STAFF_PERMISSIONS },
    });

    patron = await loginAs('bv-patron');
    patronUserId = (
      await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'bv-patron' } })
    ).id;
    await ctx.prisma.membership.create({
      data: { userId: patronUserId, creatorId, amountCents: 500, isActivePatron: true },
    });

    otherPatron = await loginAs('bv-other-patron');
    const otherUser = await ctx.prisma.user.findUniqueOrThrow({
      where: { patreonUserId: 'bv-other-patron' },
    });
    await ctx.prisma.membership.create({
      data: { userId: otherUser.id, creatorId, amountCents: 500, isActivePatron: true },
    });

    pendingId = (await makeEntry('PENDING')).id;
    acceptedId = (await makeEntry('ACCEPTED')).id;
    rejectedId = (await makeEntry('REJECTED')).id;
    deletedId = (await makeEntry('DELETED')).id;
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
    return { session: pickCookie(res, 'pp_session'), csrf };
  }

  type Auth = Awaited<ReturnType<typeof loginAs>>;

  let counter = 0;
  async function makeEntry(
    status: 'PENDING' | 'ACCEPTED' | 'ACTIVE' | 'COMPLETED' | 'REJECTED' | 'DELETED',
  ) {
    counter += 1;
    return ctx.prisma.recommendation.create({
      data: {
        creatorId,
        submittedByUserId: patronUserId,
        type: 'EXTERNAL_LINK',
        customTitle: `Visible ${counter}`,
        normalizedTitle: `visible ${counter}`,
        status,
      },
    });
  }

  const board = (auth?: Auth) => {
    const req = request(ctx.app.getHttpServer()).get(
      '/api/v1/creators/visibility-co/recommendations?limit=50',
    );
    return auth ? req.set('Cookie', [auth.session, auth.csrf]) : req;
  };

  const column = (status: string, auth?: Auth, extra = '') => {
    const req = request(ctx.app.getHttpServer()).get(
      `/api/v1/creators/visibility-co/recommendations?status=${status}${extra}`,
    );
    return auth ? req.set('Cookie', [auth.session, auth.csrf]) : req;
  };

  const ids = (body: { items: Array<{ id: string }> }) => body.items.map((i) => i.id);

  const setHidePending = (hidePendingFromPublic: boolean) =>
    ctx.prisma.creatorPolicy.update({ where: { creatorId }, data: { hidePendingFromPublic } });

  beforeEach(async () => {
    await setHidePending(false);
  });

  describe('asking for one column', () => {
    it('returns only that column', async () => {
      const res = await column('ACCEPTED', patron).expect(200);

      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items.every((item: { status: string }) => item.status === 'ACCEPTED')).toBe(
        true,
      );
    });

    it('never widens what the reader may see', async () => {
      // The filter narrows visibility rather than replacing it. Asking for a column a patron
      // cannot see has to be empty — if this ever returns rows, the status filter has been
      // composed in a way that overwrites the visibility rule.
      expect((await column('REJECTED', patron).expect(200)).body.items).toEqual([]);
      expect((await column('DELETED', patron).expect(200)).body.items).toEqual([]);
    });

    it('is empty for an anonymous visitor too', async () => {
      expect((await column('REJECTED').expect(200)).body.items).toEqual([]);
    });

    it('hides a pending column from other patrons when the toggle is on', async () => {
      await setHidePending(true);

      expect((await column('PENDING', otherPatron).expect(200)).body.items).toEqual([]);
    });

    it('shows staff the column they work', async () => {
      const res = await column('REJECTED', staff).expect(200);

      expect(ids(res.body)).toContain(rejectedId);
    });

    it('paginates within the column rather than across the board', async () => {
      const first = await column('ACCEPTED', staff, '&limit=1').expect(200);
      expect(first.body.items).toHaveLength(1);

      if (first.body.nextCursor) {
        const second = await column('ACCEPTED', staff, `&limit=1&cursor=${first.body.nextCursor}`);
        expect(second.body.items[0]?.id).not.toBe(first.body.items[0].id);
      }
    });

    it('rejects a status that is not one', async () => {
      await column('BANANA', patron).expect(400);
    });
  });

  it('hides rejected and deleted entries from patrons', async () => {
    const res = await board(patron).expect(200);
    expect(ids(res.body)).not.toContain(rejectedId);
    expect(ids(res.body)).not.toContain(deletedId);
    expect(ids(res.body)).toContain(acceptedId);
  });

  it('shows rejected and deleted entries to staff', async () => {
    const res = await board(staff).expect(200);
    expect(ids(res.body)).toEqual(expect.arrayContaining([rejectedId, deletedId]));
  });

  it('shows pending entries to everyone when the toggle is off', async () => {
    const res = await board(otherPatron).expect(200);
    expect(ids(res.body)).toContain(pendingId);
  });

  it('hides pending entries from other patrons when the toggle is on', async () => {
    await setHidePending(true);
    const res = await board(otherPatron).expect(200);
    expect(ids(res.body)).not.toContain(pendingId);
    expect(ids(res.body)).toContain(acceptedId);
  });

  it('still shows a patron their own pending entry when the toggle is on', async () => {
    // Otherwise the submit form returns success and the board comes back empty, which reads as
    // a bug to the person who just used it.
    await setHidePending(true);
    const res = await board(patron).expect(200);
    expect(ids(res.body)).toContain(pendingId);
  });

  it('hides pending entries from an anonymous visitor when the toggle is on', async () => {
    // The "own submission" carve-out keys on user id; anonymous has none and must not match all.
    await setHidePending(true);
    const res = await board().expect(200);
    expect(ids(res.body)).not.toContain(pendingId);
  });

  it('keeps the visibility filter on every page, not just the first', async () => {
    // The cursor clause and the visibility clause both wanted the `OR` key, and the spread let
    // the cursor overwrite it — so page 2 came back with no status filter at all.
    await setHidePending(true);
    // Enough visible entries that a limit of 1 actually produces a second page — with a single
    // survivor the first page carries no cursor and the paged path is never reached.
    const extra = [await makeEntry('ACCEPTED'), await makeEntry('COMPLETED')];
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const url = `/api/v1/creators/visibility-co/recommendations?limit=1${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`;
      const res = await request(ctx.app.getHttpServer())
        .get(url)
        .set('Cookie', [otherPatron.session, otherPatron.csrf])
        .expect(200);
      seen.push(...ids(res.body));
      if (!res.body.nextCursor) break;
      cursor = res.body.nextCursor;
    }
    expect(seen).not.toContain(rejectedId);
    expect(seen).not.toContain(deletedId);
    expect(seen).not.toContain(pendingId);
    expect(seen).toEqual(expect.arrayContaining([acceptedId, ...extra.map((e) => e.id)]));
  });

  it('still shows staff pending entries when the toggle is on', async () => {
    await setHidePending(true);
    const res = await board(staff).expect(200);
    expect(ids(res.body)).toContain(pendingId);
  });
});
