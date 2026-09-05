import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { MAX_NOTES_PER_ENTRY } from '../src/notes/notes.service';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';
import { ALL_STAFF_PERMISSIONS } from '../src/access/permissions';

describe('Creator notes (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let otherCreatorId: string;
  let staff: Auth;
  let patron: Auth;
  let staffUserId: string;
  let patronUserId: string;
  let recId: string;
  let foreignRecId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'nt-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'nt-campaign',
        ownerUserId: owner.id,
        displayName: 'Notes Co',
        slug: 'notes-co',
        policy: { create: { viewVisibility: 'PUBLIC' } },
      },
    });
    creatorId = creator.id;
    otherCreatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'nt-other',
          ownerUserId: owner.id,
          displayName: 'Other',
          slug: 'nt-other',
          policy: { create: { viewVisibility: 'PUBLIC' } },
        },
      })
    ).id;

    staff = await loginAs('nt-staff');
    staffUserId = (
      await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'nt-staff' } })
    ).id;
    await ctx.prisma.creatorStaff.create({
      data: { creatorId, userId: staffUserId, role: 'MOD', permissions: ALL_STAFF_PERMISSIONS },
    });

    patron = await loginAs('nt-patron');
    patronUserId = (
      await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId: 'nt-patron' } })
    ).id;
    await ctx.prisma.membership.create({
      data: { userId: patronUserId, creatorId, amountCents: 500, isActivePatron: true },
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.creatorNote.deleteMany();
    await ctx.prisma.recommendation.deleteMany();
    recId = (await makeEntry(creatorId)).id;
    foreignRecId = (await makeEntry(otherCreatorId)).id;
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

  type Auth = Awaited<ReturnType<typeof loginAs>>;

  let counter = 0;
  async function makeEntry(target: string) {
    counter += 1;
    return ctx.prisma.recommendation.create({
      data: {
        creatorId: target,
        submittedByUserId: patronUserId,
        type: 'EXTERNAL_LINK',
        customTitle: `Entry ${counter}`,
        normalizedTitle: `entry ${counter}`,
      },
    });
  }

  const post = (auth: Auth, path: string, body: object) =>
    request(ctx.app.getHttpServer())
      .post(`/api/v1${path}`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  const patch = (auth: Auth, path: string, body: object) =>
    request(ctx.app.getHttpServer())
      .patch(`/api/v1${path}`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  const del = (auth: Auth, path: string) =>
    request(ctx.app.getHttpServer())
      .delete(`/api/v1${path}`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken);

  const write = (body: object, target = recId) =>
    post(staff, `/creators/notes-co/recommendations/${target}/notes`, body);

  const board = (auth?: Auth) => {
    const req = request(ctx.app.getHttpServer()).get(
      '/api/v1/creators/notes-co/recommendations?limit=50',
    );
    return auth ? req.set('Cookie', [auth.session, auth.csrf]) : req;
  };

  const queue = () =>
    request(ctx.app.getHttpServer())
      .get('/api/v1/creators/notes-co/review-queue')
      .set('Cookie', [staff.session, staff.csrf]);

  describe('writing', () => {
    it('records a note against the entry with its author', async () => {
      const res = await write({ kind: 'NOTE', body: 'Worth doing after the finale.' }).expect(201);
      expect(res.body).toMatchObject({ kind: 'NOTE', body: 'Worth doing after the finale.' });
      expect(res.body.author.id).toBe(staffUserId);
    });

    it('accepts a planned date on a timeline note', async () => {
      const res = await write({
        kind: 'TIMELINE',
        body: 'March stream',
        plannedFor: '2026-03-01T00:00:00.000Z',
      }).expect(201);
      expect(res.body.plannedFor).toBe('2026-03-01T00:00:00.000Z');
    });

    it('refuses a planned date on editor commentary', async () => {
      // Nothing renders it, and the check constraint agrees.
      await write({ kind: 'NOTE', body: 'x', plannedFor: '2026-03-01T00:00:00.000Z' }).expect(400);
    });

    it('refuses a patron', async () => {
      await post(patron, `/creators/notes-co/recommendations/${recId}/notes`, {
        kind: 'NOTE',
        body: 'mine',
      }).expect(403);
    });

    it('refuses an entry on another creator board', async () => {
      await write({ kind: 'NOTE', body: 'x' }, foreignRecId).expect(404);
    });

    it('moderates the body', async () => {
      // A creator's own words still land on a public board when the kind is TIMELINE.
      await write({ kind: 'TIMELINE', body: 'this is shit' }).expect(400);
      expect(await ctx.prisma.creatorNote.count()).toBe(0);
    });

    it('caps how many notes an entry can carry', async () => {
      for (let i = 0; i < MAX_NOTES_PER_ENTRY; i += 1) {
        await write({ kind: 'NOTE', body: `note ${i}` }).expect(201);
      }
      await write({ kind: 'NOTE', body: 'one too many' }).expect(409);
    });

    it('rejects an empty or oversized body', async () => {
      await write({ kind: 'NOTE', body: '' }).expect(400);
      await write({ kind: 'NOTE', body: 'x'.repeat(2001) }).expect(400);
    });

    it('rejects a body that is only whitespace', async () => {
      // Trimmed before the length check: otherwise "   " passed and stored as "", which renders
      // as an empty bullet — on the public board when the kind is TIMELINE.
      await write({ kind: 'NOTE', body: '     ' }).expect(400);
    });

    it('accepts an explicit null date on commentary', async () => {
      // "No date" is what a client naturally sends on a NOTE; it is not an error.
      await write({ kind: 'NOTE', body: 'x', plannedFor: null }).expect(201);
    });

    it('keeps the cap under concurrent writes', async () => {
      // A read-then-write cap does not survive a double-click.
      for (let i = 0; i < MAX_NOTES_PER_ENTRY - 1; i += 1) {
        await write({ kind: 'NOTE', body: `note ${i}` }).expect(201);
      }
      await Promise.all(
        Array.from({ length: 6 }, (_unused, i) => write({ kind: 'NOTE', body: `race ${i}` })),
      );
      expect(await ctx.prisma.creatorNote.count({ where: { recommendationId: recId } })).toBe(
        MAX_NOTES_PER_ENTRY,
      );
    });
  });

  describe('editing and deleting', () => {
    it('edits a note', async () => {
      const { body: note } = await write({ kind: 'NOTE', body: 'first' }).expect(201);
      const res = await patch(staff, `/creators/notes-co/notes/${note.id}`, {
        body: 'second',
      }).expect(200);
      expect(res.body.body).toBe('second');
    });

    it('refuses a planned date when editing commentary', async () => {
      // The only untested branch between a client and the CHECK constraint — removing the guard
      // turns this into a 500.
      const { body: note } = await write({ kind: 'NOTE', body: 'fine' }).expect(201);
      await patch(staff, `/creators/notes-co/notes/${note.id}`, {
        body: 'fine',
        plannedFor: '2026-03-01T00:00:00.000Z',
      }).expect(400);
    });

    it('clears a planned date with an explicit null, and leaves it alone when omitted', async () => {
      // Omitting preserved the date and null wrote the Unix epoch, so there was no way to clear
      // one — and the input a client would reach for was the one that corrupted it.
      const { body: note } = await write({
        kind: 'TIMELINE',
        body: 'March',
        plannedFor: '2026-03-01T00:00:00.000Z',
      }).expect(201);

      const kept = await patch(staff, `/creators/notes-co/notes/${note.id}`, {
        body: 'March still',
      }).expect(200);
      expect(kept.body.plannedFor).toBe('2026-03-01T00:00:00.000Z');

      const cleared = await patch(staff, `/creators/notes-co/notes/${note.id}`, {
        body: 'sometime',
        plannedFor: null,
      }).expect(200);
      expect(cleared.body.plannedFor).toBeNull();
    });

    it('moderates an edited body', async () => {
      const { body: note } = await write({ kind: 'NOTE', body: 'fine' }).expect(201);
      await patch(staff, `/creators/notes-co/notes/${note.id}`, {
        body: 'this is shit',
      }).expect(400);
    });

    it('deletes a note', async () => {
      const { body: note } = await write({ kind: 'NOTE', body: 'gone' }).expect(201);
      await del(staff, `/creators/notes-co/notes/${note.id}`).expect(204);
      expect(await ctx.prisma.creatorNote.count()).toBe(0);
    });

    it('refuses a patron editing or deleting', async () => {
      const { body: note } = await write({ kind: 'NOTE', body: 'x' }).expect(201);
      await patch(patron, `/creators/notes-co/notes/${note.id}`, { body: 'y' }).expect(403);
      await del(patron, `/creators/notes-co/notes/${note.id}`).expect(403);
    });

    it('refuses to edit or delete a note on another creator board', async () => {
      // A note id alone says nothing about which board it belongs to.
      const foreign = await ctx.prisma.creatorNote.create({
        data: {
          recommendationId: foreignRecId,
          authorUserId: staffUserId,
          kind: 'NOTE',
          body: 'theirs',
        },
      });
      await patch(staff, `/creators/notes-co/notes/${foreign.id}`, { body: 'mine' }).expect(404);
      await del(staff, `/creators/notes-co/notes/${foreign.id}`).expect(404);
    });

    it('404s an unknown note', async () => {
      await del(staff, `/creators/notes-co/notes/${randomUUID()}`).expect(404);
    });
  });

  describe('reading', () => {
    const PRIVATE = 'internal thinking nobody outside should read';

    beforeEach(async () => {
      await write({ kind: 'NOTE', body: PRIVATE }).expect(201);
      await write({
        kind: 'TIMELINE',
        body: 'Covering this in March',
        plannedFor: '2026-03-01T00:00:00.000Z',
      }).expect(201);
    });

    it('shows timeline notes on the patron board', async () => {
      const res = await board(patron).expect(200);
      const entry = res.body.items.find((i: { id: string }) => i.id === recId);
      expect(entry.notes).toEqual([
        expect.objectContaining({ kind: 'TIMELINE', body: 'Covering this in March' }),
      ]);
    });

    it('never shows editor commentary to a patron', async () => {
      // The whole point of the kind. Asserted against the entire serialised response, so a note
      // leaking through any other field still fails it.
      const res = await board(patron).expect(200);
      expect(JSON.stringify(res.body)).not.toContain(PRIVATE);
    });

    it('never shows editor commentary to an anonymous visitor', async () => {
      const res = await board().expect(200);
      expect(JSON.stringify(res.body)).not.toContain(PRIVATE);
    });

    it('shows both kinds to staff in the review queue', async () => {
      const res = await queue().expect(200);
      const entry = res.body.items.find((i: { id: string }) => i.id === recId);
      expect(entry.notes.map((n: { kind: string }) => n.kind).sort()).toEqual(['NOTE', 'TIMELINE']);
    });

    it('orders notes oldest first', async () => {
      // A timeline read backwards is not a timeline.
      await write({ kind: 'NOTE', body: 'third' }).expect(201);
      const res = await queue().expect(200);
      const entry = res.body.items.find((i: { id: string }) => i.id === recId);
      expect(entry.notes.map((n: { body: string }) => n.body)).toEqual([
        PRIVATE,
        'Covering this in March',
        'third',
      ]);
    });

    it('never shows editor commentary in a submit response', async () => {
      // The submit and board projections share one constant today; if they ever diverge this is
      // what fails rather than a patron reading a moderator's private note.
      const res = await post(patron, '/creators/notes-co/recommendations', {
        type: 'EXTERNAL_LINK',
        customTitle: 'Entry 1',
      });
      expect(JSON.stringify(res.body)).not.toContain(PRIVATE);
    });

    it('leaves an entry with no notes an empty array', async () => {
      const bare = await makeEntry(creatorId);
      const res = await board(patron).expect(200);
      const entry = res.body.items.find((i: { id: string }) => i.id === bare.id);
      expect(entry.notes).toEqual([]);
    });
  });
});
