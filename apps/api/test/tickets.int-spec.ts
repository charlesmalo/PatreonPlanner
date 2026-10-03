import request from 'supertest';
import { ALL_STAFF_PERMISSIONS } from '../src/access/permissions';
import { NotificationsService } from '../src/notifications/notifications.service';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Tickets (integration)', () => {
  let ctx: AuthTestContext;
  let notifications: NotificationsService;
  let creatorId: string;
  let owner: Auth;
  let handler: Auth;
  let handlerUserId: string;
  let bystander: Auth;
  let patron: Auth;
  let patronUserId: string;
  /** Someone who can read this public board and has written nothing on it. */
  let stranger: Auth;
  let entryId: string;
  let anonCsrf: string;
  let anonToken: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    notifications = ctx.app.get(NotificationsService);
    owner = await loginAs('tk-owner');
    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'tk-campaign',
          ownerUserId: await userId('tk-owner'),
          displayName: 'Ticket Co',
          slug: 'ticket-co',
          policy: { create: { viewVisibility: 'PUBLIC' } },
          staff: { create: { userId: await userId('tk-owner'), role: 'OWNER' } },
        },
      })
    ).id;

    handler = await loginAs('tk-handler');
    handlerUserId = await userId('tk-handler');
    await ctx.prisma.creatorStaff.create({
      data: {
        creatorId,
        userId: handlerUserId,
        role: 'MOD',
        permissions: ['HANDLE_REPORTS'],
      },
    });
    // Staff, but without the permission — the case that proves the gate is the
    // permission rather than merely being staff.
    bystander = await loginAs('tk-bystander');
    await ctx.prisma.creatorStaff.create({
      data: {
        creatorId,
        userId: await userId('tk-bystander'),
        role: 'MOD',
        permissions: ['WRITE_NOTES'],
      },
    });

    const visit = await request(ctx.app.getHttpServer()).get('/api/v1/creators/ticket-co');
    anonCsrf = pickCookie(visit, 'pp_csrf').split(';')[0];
    anonToken = anonCsrf.split('=').slice(1).join('=');

    patron = await loginAs('tk-patron');
    patronUserId = await userId('tk-patron');
    await ctx.prisma.membership.create({
      data: { userId: patronUserId, creatorId, amountCents: 500, isActivePatron: true },
    });

    stranger = await loginAs('tk-stranger');
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.ticket.deleteMany();
    await ctx.prisma.notification.deleteMany();
    await ctx.prisma.abuseRecord.deleteMany();
    await ctx.prisma.recommendation.deleteMany();
    await ctx.prisma.creatorPolicy.update({
      where: { creatorId },
      data: { allowAnonymousTickets: false },
    });
    entryId = (
      await ctx.prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: patronUserId,
          type: 'EXTERNAL_LINK',
          customTitle: 'Re:Zero',
          normalizedTitle: 're:zero',
          status: 'PENDING',
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

  /**
   * An anonymous caller still carries a CSRF token — a browser is issued one on its first safe
   * request. Without it the middleware answers 403 before the endpoint is reached, and the test
   * would pass on the wrong refusal.
   */
  const raise = (auth: Auth | null, body: object, slug = 'ticket-co') => {
    const req = request(ctx.app.getHttpServer()).post(`/api/v1/creators/${slug}/tickets`);
    if (auth) {
      req.set('Cookie', [auth.session, auth.csrf]).set('x-csrf-token', auth.csrfToken);
    } else {
      // An anonymous caller still carries a CSRF token — a browser is issued one on its first
      // safe request. Without it the middleware answers 403 before the endpoint is reached, and
      // a test would pass on the wrong refusal.
      req.set('Cookie', [anonCsrf]).set('x-csrf-token', anonToken);
    }
    return req.send(body);
  };

  const list = (auth: Auth, query = '') =>
    request(ctx.app.getHttpServer())
      .get(`/api/v1/creators/ticket-co/tickets${query}`)
      .set('Cookie', [auth.session, auth.csrf]);

  /** No CSRF token: a GET is safe, and the middleware does not demand one. */
  const readOne = (auth: Auth | null, id: string, slug = 'ticket-co') => {
    const req = request(ctx.app.getHttpServer()).get(`/api/v1/creators/${slug}/tickets/${id}`);
    if (auth) req.set('Cookie', [auth.session, auth.csrf]);
    return req;
  };

  const resolve = (auth: Auth, id: string, body: object) =>
    request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/ticket-co/tickets/${id}`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);

  describe('raising one', () => {
    it('takes a message with no subject, which is general contact', async () => {
      const res = await raise(patron, { body: 'Could you cover more anime?' }).expect(201);

      expect(res.body).toMatchObject({ status: 'OPEN', subjectId: null });
    });

    it('takes a message about an entry, which is a dispute', async () => {
      const res = await raise(patron, {
        body: 'This is season 3, not a duplicate of season 1.',
        subjectId: entryId,
      }).expect(201);

      expect(res.body).toMatchObject({ status: 'OPEN', subjectId: entryId });
    });

    it('refuses a signed-out reader by default', async () => {
      // A public contact form on a public board is the highest-value spam target in the app.
      await raise(null, { body: 'Hello there' }).expect(403);
    });

    it('accepts a signed-out reader when the creator opts in', async () => {
      await ctx.prisma.creatorPolicy.update({
        where: { creatorId },
        data: { allowAnonymousTickets: true },
      });

      await raise(null, { body: 'Hello from nobody at all' }).expect(201);
    });

    it('runs the body through the moderation pipeline', async () => {
      // Attacker-chosen text a moderator will read; design §6.5 exempts nothing.
      await raise(patron, { body: 'this is shit' }).expect(400);
    });

    it('404s a subject on another board', async () => {
      const other = await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'tk-other',
          ownerUserId: await userId('tk-owner'),
          displayName: 'Other',
          slug: 'tk-other',
          policy: { create: { viewVisibility: 'PUBLIC' } },
        },
      });
      const foreign = await ctx.prisma.recommendation.create({
        data: {
          creatorId: other.id,
          submittedByUserId: patronUserId,
          type: 'EXTERNAL_LINK',
          customTitle: 'Elsewhere',
          normalizedTitle: 'elsewhere',
        },
      });

      await raise(patron, { body: 'About this one', subjectId: foreign.id }).expect(404);

      await ctx.prisma.creator.delete({ where: { id: other.id } });
    });

    it('tells the staff who would handle it, and only them', async () => {
      await raise(patron, { body: 'Something needs looking at' }).expect(201);

      expect(await notifications.unreadCount(handlerUserId)).toBe(1);
      // Not staff who cannot act on it: the bystander moderates this board but holds only
      // WRITE_NOTES, so a ticket is not theirs to hear about.
      expect(await notifications.unreadCount(await userId('tk-bystander'))).toBe(0);
      // Not the person who raised it.
      expect(await notifications.unreadCount(patronUserId)).toBe(0);
    });
  });

  describe('working the inbox', () => {
    const openOne = async (body = 'Please look at this') =>
      (await raise(patron, { body, subjectId: entryId }).expect(201)).body.id as string;

    it('lists what is open', async () => {
      await openOne('The first message in the inbox');

      const res = await list(handler).expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({
        body: 'The first message in the inbox',
        status: 'OPEN',
      });
    });

    it('refuses a moderator without the permission', async () => {
      // Being staff is not the gate; holding HANDLE_REPORTS is.
      await openOne();

      await list(bystander).expect(403);
    });

    it('refuses a patron', async () => {
      await openOne();

      await list(patron).expect(403);
    });

    it('records the resolution, the reply and who answered', async () => {
      const id = await openOne();

      await resolve(handler, id, {
        resolution: 'CONFIRMED',
        reply: 'You are right — separating them now.',
      }).expect(200);

      const row = await ctx.prisma.ticket.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        status: 'RESOLVED',
        resolution: 'CONFIRMED',
        reply: 'You are right — separating them now.',
        resolvedByUserId: handlerUserId,
      });
    });

    it('records a resolution even when the reply says nothing', async () => {
      // "Handled internally" is a legitimate answer to a reader. It is not a legitimate answer
      // to the audit trail, so the resolution is recorded regardless.
      const id = await openOne();

      await resolve(handler, id, {
        resolution: 'DENIED',
        reply: 'This ticket has been handled internally and resolved.',
      }).expect(200);

      const row = await ctx.prisma.ticket.findUniqueOrThrow({ where: { id } });
      expect(row.resolution).toBe('DENIED');
    });

    it('drops a resolved ticket from the open list', async () => {
      const id = await openOne();
      await resolve(handler, id, { resolution: 'CLOSED' }).expect(200);

      expect((await list(handler).expect(200)).body.items).toEqual([]);
      expect((await list(handler, '?status=RESOLVED').expect(200)).body.items).toHaveLength(1);
    });

    it('tells the reader what was decided', async () => {
      const id = await openOne();

      await resolve(handler, id, { resolution: 'CONFIRMED', reply: 'Fixed, thank you.' }).expect(
        200,
      );

      expect(await notifications.unreadCount(patronUserId)).toBe(1);
      const { items } = await notifications.list(patronUserId);
      expect(items[0].payload).toMatchObject({ reply: 'Fixed, thank you.' });
    });

    it('404s a ticket on another board', async () => {
      const other = await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'tk-other2',
          ownerUserId: await userId('tk-owner'),
          displayName: 'Other',
          slug: 'tk-other2',
          policy: { create: { viewVisibility: 'PUBLIC' } },
          staff: {
            create: {
              userId: handlerUserId,
              role: 'MOD',
              permissions: ALL_STAFF_PERMISSIONS as never,
            },
          },
        },
      });
      const id = await openOne();

      await request(ctx.app.getHttpServer())
        .patch(`/api/v1/creators/tk-other2/tickets/${id}`)
        .set('Cookie', [handler.session, handler.csrf])
        .set('x-csrf-token', handler.csrfToken)
        .send({ resolution: 'CLOSED' })
        .expect(404);

      await ctx.prisma.creator.delete({ where: { id: other.id } });
    });

    it('keeps the message when the entry it was about is deleted', async () => {
      // The reader's own words are the substance; the card is context.
      const id = await openOne('This is season 3, not a duplicate');
      await ctx.prisma.recommendation.delete({ where: { id: entryId } });

      const row = await ctx.prisma.ticket.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ body: 'This is season 3, not a duplicate', subjectId: null });
    });
  });

  describe('reading one', () => {
    const openOne = async (auth: Auth | null = patron, body = 'Please look at this') =>
      (await raise(auth, { body, subjectId: entryId }).expect(201)).body.id as string;

    it('gives a handler the one message a notification named', async () => {
      const id = await openOne(patron, 'The message the notification is about');

      const res = await readOne(handler, id).expect(200);

      expect(res.body).toMatchObject({
        id,
        body: 'The message the notification is about',
        status: 'OPEN',
        subject: { id: entryId },
      });
    });

    it('gives the reader who raised it their own message and the answer', async () => {
      // The fixture that matters: a patron, not staff, holding no permission — exactly who a
      // TICKET_RESOLVED notification is sent to, and who the list endpoint refuses.
      const id = await openOne();
      await resolve(handler, id, { resolution: 'CONFIRMED', reply: 'Fixed, thank you.' }).expect(
        200,
      );

      const res = await readOne(patron, id).expect(200);

      expect(res.body).toMatchObject({
        id,
        status: 'RESOLVED',
        resolution: 'CONFIRMED',
        reply: 'Fixed, thank you.',
      });
    });

    it('hides another reader’s message as a 404, not a refusal', async () => {
      // A reader who can see this board and did not write this message. 404 rather than 403:
      // telling them the id exists confirms a message they are not party to.
      const id = await openOne();

      await readOne(stranger, id).expect(404);
    });

    it('does not hand an anonymous message to the next anonymous reader', async () => {
      // `raisedByUserId` is null on an anonymous ticket and `viewer.userId` is null for an
      // anonymous reader, so an ownership test written as equality would match every one of
      // them against every anonymous message on the board.
      await ctx.prisma.creatorPolicy.update({
        where: { creatorId },
        data: { allowAnonymousTickets: true },
      });
      const id = await openOne(null, 'Hello from nobody at all');

      await readOne(null, id).expect(404);
    });

    it('hides a message from a moderator without the permission', async () => {
      // Being staff is not the gate here either: HANDLE_REPORTS is, or having written it.
      const id = await openOne();

      await readOne(bystander, id).expect(404);
    });

    it('404s a ticket on another board', async () => {
      const other = await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'tk-other3',
          ownerUserId: await userId('tk-owner'),
          displayName: 'Other',
          slug: 'tk-other3',
          policy: { create: { viewVisibility: 'PUBLIC' } },
          staff: {
            create: {
              userId: handlerUserId,
              role: 'MOD',
              permissions: ALL_STAFF_PERMISSIONS as never,
            },
          },
        },
      });
      const id = await openOne();

      await readOne(handler, id, 'tk-other3').expect(404);

      await ctx.prisma.creator.delete({ where: { id: other.id } });
    });

    it('404s an id no ticket has', async () => {
      await readOne(handler, '00000000-0000-0000-0000-00000000dead').expect(404);
    });
  });
});
