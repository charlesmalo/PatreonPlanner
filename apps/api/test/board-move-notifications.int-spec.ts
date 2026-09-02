import { ModerationActionsService } from '../src/moderation/moderation-actions.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';
import { ALL_STAFF_PERMISSIONS } from '../src/access/permissions';
import { BoardFollowersService } from '../src/notifications/board-followers.service';

describe('Following what moves (integration)', () => {
  let ctx: AuthTestContext;
  let notifications: NotificationsService;
  let actions: ModerationActionsService;
  let creatorId: string;
  let owner: string;
  let moderator: string;
  let patron: string;
  let follower: string;
  let lapsedFollower: string;
  let stranger: string;
  let recId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    notifications = ctx.app.get(NotificationsService);
    actions = ctx.app.get(ModerationActionsService);

    const user = async (patreonUserId: string) =>
      (await ctx.prisma.user.create({ data: { patreonUserId } })).id;
    owner = await user('bm-owner');
    moderator = await user('bm-mod');
    patron = await user('bm-patron');
    follower = await user('bm-follower');
    lapsedFollower = await user('bm-lapsed');
    stranger = await user('bm-stranger');

    creatorId = (
      await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'bm-campaign',
          ownerUserId: owner,
          displayName: 'Move Co',
          slug: 'move-co',
          policy: { create: {} },
          staff: { create: { userId: owner, role: 'OWNER' } },
        },
      })
    ).id;
    await ctx.prisma.creatorStaff.create({
      data: { creatorId, userId: moderator, role: 'MOD', permissions: ALL_STAFF_PERMISSIONS },
    });
    // Everyone but the lapsed follower actually pledges, so a SUBSCRIBERS_ONLY board is readable
    // by them — the lapsed one is the whole point of the visibility test below.
    for (const id of [moderator, patron, follower, stranger]) {
      await ctx.prisma.membership.create({
        data: { userId: id, creatorId, amountCents: 500, isActivePatron: true },
      });
    }
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.notification.deleteMany();
    await ctx.prisma.creatorFavorite.deleteMany();
    await ctx.prisma.entryFollow.deleteMany();
    // Themes are unique per (creator, slug), so one block creating "Documentary" and leaving it
    // makes the next block's create fail for a reason nowhere near what it is testing.
    await ctx.prisma.titleTheme.deleteMany();
    await ctx.prisma.theme.deleteMany();
    await ctx.prisma.boardNotificationPreference.deleteMany();
    await ctx.prisma.titleTheme.deleteMany();
    await ctx.prisma.title.deleteMany();
    await ctx.prisma.recommendation.deleteMany();
    await setVisibility('PUBLIC');
    recId = (
      await ctx.prisma.recommendation.create({
        data: {
          creatorId,
          submittedByUserId: patron,
          type: 'MOVIE',
          customTitle: 'Cowboy Bebop',
          normalizedTitle: 'cowboy bebop',
        },
      })
    ).id;
  });

  const favourite = (userId: string) =>
    ctx.prisma.creatorFavorite.create({ data: { userId, creatorId } });

  const setVisibility = (value: 'PUBLIC' | 'ANY_PATREON_USER' | 'SUBSCRIBERS_ONLY') =>
    ctx.prisma.creatorPolicy.update({ where: { creatorId }, data: { viewVisibility: value } });

  /** PENDING → ACCEPTED → ACTIVE, which is the only legal route to Now Playing. */
  const moveToActive = async () => {
    await actions.changeStatus(creatorId, recId, moderator, 'ACCEPTED');
    await actions.changeStatus(creatorId, recId, moderator, 'ACTIVE');
  };

  it('tells a follower when an entry reaches ACTIVE', async () => {
    await favourite(follower);

    await moveToActive();

    const { items } = await notifications.list(follower);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('ENTRY_MOVED');
    expect(items[0].payload).toMatchObject({
      recommendationId: recId,
      title: 'Cowboy Bebop',
      status: 'ACTIVE',
      creatorSlug: 'move-co',
    });
  });

  it('says nothing to a follower for a move to ACCEPTED by default', async () => {
    // Board administration, not news. Defaulting to every move makes the first login a firehose
    // and turns this into a feature people switch off before they ever configure it.
    await favourite(follower);

    await actions.changeStatus(creatorId, recId, moderator, 'ACCEPTED');

    expect(await notifications.unreadCount(follower)).toBe(0);
  });

  it('tells a follower when an entry is COMPLETED', async () => {
    await favourite(follower);

    await moveToActive();
    await ctx.prisma.notification.deleteMany();
    await actions.changeStatus(creatorId, recId, moderator, 'COMPLETED');

    expect(await notifications.unreadCount(follower)).toBe(1);
  });

  it('honours an explicit silence, which is not the same as having no preference', async () => {
    // An absent row means the default; an empty array means "nothing from this board". Collapse
    // the two and a reader who asked for quiet is indistinguishable from one who never chose —
    // so any later change to the default silently un-silences them.
    await favourite(follower);
    await ctx.prisma.boardNotificationPreference.create({
      data: { userId: follower, creatorId, statuses: [] },
    });

    await moveToActive();

    expect(await notifications.unreadCount(follower)).toBe(0);
  });

  it('honours a preference that asks for a move the default ignores', async () => {
    await favourite(follower);
    await ctx.prisma.boardNotificationPreference.create({
      data: { userId: follower, creatorId, statuses: ['ACCEPTED'] },
    });

    await actions.changeStatus(creatorId, recId, moderator, 'ACCEPTED');

    expect(await notifications.unreadCount(follower)).toBe(1);
  });

  it('folds a second move into the one already waiting', async () => {
    // Eight entries tidied into Now Playing is one act, not eight pieces of news. The newest
    // move is the headline because it is the one a reader cares about most; burying it under
    // seven older ones is the flooding this exists to prevent.
    await favourite(follower);

    await moveToActive();
    await actions.changeStatus(creatorId, recId, moderator, 'COMPLETED');

    const { items } = await notifications.list(follower);
    expect(items).toHaveLength(1);
    expect(items[0].payload).toMatchObject({ status: 'COMPLETED' });
    expect(items[0].groupCount).toBe(2);
  });

  it('surfaces a folded notification as fresh news rather than leaving it buried', async () => {
    // The bell sorts on createdAt. A rewritten row that keeps its original timestamp sinks below
    // older and less interesting items, which defeats the point of putting the newest move in it.
    await favourite(follower);
    await moveToActive();
    const first = await ctx.prisma.notification.findFirstOrThrow({
      where: { userId: follower, type: 'ENTRY_MOVED' },
    });

    // Back-dated deliberately. Both writes otherwise land within the same millisecond on a fast
    // machine — `now()` has microsecond resolution in Postgres but a JS Date does not — so the
    // original assertion failed or passed on how quick the database happened to be, which is not
    // what this test is about. An hour of separation makes the comparison mean what it says.
    const anHourAgo = new Date(Date.now() - 3_600_000);
    await ctx.prisma.notification.update({
      where: { id: first.id },
      data: { createdAt: anHourAgo },
    });

    await actions.changeStatus(creatorId, recId, moderator, 'COMPLETED');

    const folded = await ctx.prisma.notification.findFirstOrThrow({
      where: { userId: follower, type: 'ENTRY_MOVED' },
    });
    expect(folded.id).toBe(first.id);
    expect(folded.createdAt.getTime()).toBeGreaterThan(anHourAgo.getTime());
  });

  it('starts a fresh notification once the last one has been read', async () => {
    await favourite(follower);
    await moveToActive();
    await notifications.markRead(follower);

    await actions.changeStatus(creatorId, recId, moderator, 'COMPLETED');

    const { items } = await notifications.list(follower);
    expect(items).toHaveLength(2);
    expect(items[0].groupCount).toBe(1);
  });

  it('does not fold one reader’s notification into another’s', async () => {
    // A grouping keyed on the board alone rather than on (reader, board) collapses everybody's
    // into one row and hands it to whoever the UPDATE touched last.
    await favourite(follower);
    await favourite(stranger);

    await moveToActive();

    expect(await notifications.unreadCount(follower)).toBe(1);
    expect(await notifications.unreadCount(stranger)).toBe(1);
    const both = await ctx.prisma.notification.findMany({ where: { type: 'ENTRY_MOVED' } });
    expect(both.map((n) => n.groupCount)).toEqual([1, 1]);
  });

  it('never rewrites the notification of somebody not in this move’s audience', async () => {
    // The leak the reader scope prevents. This follower asked to hear about ACTIVE only, so the
    // move to COMPLETED is not theirs — but a fold keyed on the board alone would rewrite their
    // waiting row with a title from an event they deliberately opted out of.
    await favourite(follower);
    await ctx.prisma.boardNotificationPreference.create({
      data: { userId: follower, creatorId, statuses: ['ACTIVE'] },
    });
    await favourite(stranger);

    await moveToActive();
    await actions.changeStatus(creatorId, recId, moderator, 'COMPLETED');

    const theirs = await ctx.prisma.notification.findFirstOrThrow({
      where: { userId: follower, type: 'ENTRY_MOVED' },
    });
    expect(theirs.payload).toMatchObject({ status: 'ACTIVE' });
    expect(theirs.groupCount).toBe(1);
    // The reader who did want it still gets the fold, so this is not passing by refusing everyone.
    const others = await ctx.prisma.notification.findFirstOrThrow({
      where: { userId: stranger, type: 'ENTRY_MOVED' },
    });
    expect(others.payload).toMatchObject({ status: 'COMPLETED' });
    expect(others.groupCount).toBe(2);
  });

  it('leaves a report notification out of the group', async () => {
    // ENTRY_FLAGGED coalesces too, with different reasoning. A predicate that catches both would
    // rewrite a moderator's report into a board update and lose the report entirely.
    // The owner, not the moderator: the moderator is excluded from the audience as the actor, so
    // the reader scope would mask a missing type filter and the test would prove nothing.
    await favourite(owner);
    await ctx.prisma.notification.create({
      data: {
        userId: owner,
        creatorId,
        type: 'ENTRY_FLAGGED',
        payload: { recommendationId: recId, title: 'Cowboy Bebop', creatorSlug: 'move-co' },
      },
    });

    await moveToActive();

    const flag = await ctx.prisma.notification.findFirstOrThrow({
      where: { userId: owner, type: 'ENTRY_FLAGGED' },
    });
    expect(flag.groupCount).toBe(1);
    expect(flag.payload).toMatchObject({ title: 'Cowboy Bebop' });
  });

  describe('narrowing by theme', () => {
    let anime: string;
    let documentary: string;
    let titleId: string;

    beforeEach(async () => {
      const theme = async (name: string) =>
        (
          await ctx.prisma.theme.create({
            data: { creatorId, name, slug: name.toLowerCase() },
          })
        ).id;
      anime = await theme('Anime');
      documentary = await theme('Documentary');

      const title = await ctx.prisma.title.create({
        data: { tmdbId: 987654, mediaType: 'MOVIE', name: 'Perfect Blue' },
      });
      titleId = title.id;
      await ctx.prisma.titleTheme.create({ data: { titleId, themeId: anime } });
      await ctx.prisma.recommendation.update({ where: { id: recId }, data: { titleId } });
    });

    const wants = (themeIds: string[]) =>
      ctx.prisma.boardNotificationPreference.create({
        data: { userId: follower, creatorId, statuses: ['ACTIVE'], themeIds },
      });

    it('tells a follower about a theme they asked for', async () => {
      await favourite(follower);
      await wants([anime]);

      await moveToActive();

      expect(await notifications.unreadCount(follower)).toBe(1);
    });

    it('says nothing about a theme they did not ask for', async () => {
      await favourite(follower);
      await wants([documentary]);

      await moveToActive();

      expect(await notifications.unreadCount(follower)).toBe(0);
    });

    it('treats an empty theme list as every theme, not as silence', async () => {
      // The opposite of the empty `statuses` beside it. Narrowing by theme is opted into;
      // choosing no columns is choosing nothing. Collapsing the two would silence everybody who
      // set a column preference before themes existed.
      await favourite(follower);
      await wants([]);

      await moveToActive();

      expect(await notifications.unreadCount(follower)).toBe(1);
    });

    it('matches when an entry carries any one of the themes asked for', async () => {
      await favourite(follower);
      await wants([documentary, anime]);

      await moveToActive();

      expect(await notifications.unreadCount(follower)).toBe(1);
    });

    it('says nothing about an entry with no catalogue title at all', async () => {
      // The cost of reusing the creator's themes, and the one worth knowing about: themes hang
      // off a catalogue title, so an external link or a hand-typed name carries none. A reader
      // who narrows by theme stops hearing about those entirely.
      await favourite(follower);
      await wants([anime]);
      await ctx.prisma.recommendation.update({ where: { id: recId }, data: { titleId: null } });

      await moveToActive();

      expect(await notifications.unreadCount(follower)).toBe(0);
    });

    it('leaves a follower who narrowed nothing hearing about untitled entries', async () => {
      // ...which is why the empty list has to mean "everything" rather than "nothing".
      await favourite(follower);
      await ctx.prisma.recommendation.update({ where: { id: recId }, data: { titleId: null } });

      await moveToActive();

      expect(await notifications.unreadCount(follower)).toBe(1);
    });

    it('keeps one board’s themes out of another’s decision', async () => {
      // Themes are per creator. A theme id from elsewhere must narrow to nothing rather than
      // matching by accident.
      await favourite(follower);
      const elsewhere = await ctx.prisma.creator.create({
        data: {
          patreonCampaignId: 'bm-other',
          ownerUserId: owner,
          displayName: 'Other',
          slug: 'bm-other',
          policy: { create: {} },
          staff: { create: { userId: owner, role: 'OWNER' } },
        },
      });
      const theirTheme = await ctx.prisma.theme.create({
        data: { creatorId: elsewhere.id, name: 'Anime', slug: 'anime' },
      });
      await ctx.prisma.titleTheme.create({ data: { titleId, themeId: theirTheme.id } });
      await wants([theirTheme.id]);

      await moveToActive();

      expect(await notifications.unreadCount(follower)).toBe(0);
      await ctx.prisma.creator.delete({ where: { id: elsewhere.id } });
    });
  });

  describe('following one entry', () => {
    const follows = (userId: string) =>
      ctx.prisma.entryFollow.create({ data: { userId, recommendationId: recId } });

    it('tells somebody who follows the entry but not the board', async () => {
      // The case that makes this worth building: a board too noisy to follow, with one thing on
      // it worth hearing about. Said in as many words in the original request.
      await follows(stranger);

      await moveToActive();

      expect(await notifications.unreadCount(stranger)).toBe(1);
    });

    it('reaches them even when their themes would have filtered it out', async () => {
      // Statuses answer what counts as news; themes and follows both answer about what, and a
      // follow is the most specific answer available. Somebody who narrowed to one theme and then
      // followed something outside it meant it.
      const theme = await ctx.prisma.theme.create({
        data: { creatorId, name: 'Documentary', slug: 'documentary' },
      });
      await favourite(follower);
      await ctx.prisma.boardNotificationPreference.create({
        data: { userId: follower, creatorId, statuses: ['ACTIVE'], themeIds: [theme.id] },
      });
      await follows(follower);

      await moveToActive();

      expect(await notifications.unreadCount(follower)).toBe(1);
      await ctx.prisma.theme.delete({ where: { id: theme.id } });
    });

    it('still respects which columns they asked about', async () => {
      // A reader who asked to hear only about Now Playing asked that about everything, including
      // the show they are waiting on. The two compose rather than one overriding the other.
      await favourite(follower);
      await ctx.prisma.boardNotificationPreference.create({
        data: { userId: follower, creatorId, statuses: ['COMPLETED'] },
      });
      await follows(follower);

      await moveToActive();

      expect(await notifications.unreadCount(follower)).toBe(0);
    });

    it('never reaches somebody who may not read the board', async () => {
      // A follow is a wish, not an entitlement. Somebody whose pledge lapsed stops hearing about
      // it exactly like a board follower would — the payload carries the entry's title.
      await setVisibility('SUBSCRIBERS_ONLY');
      await follows(lapsedFollower);

      await moveToActive();

      expect(await notifications.unreadCount(lapsedFollower)).toBe(0);
    });

    it('does not tell the moderator who moved it, even if they follow it', async () => {
      await follows(moderator);

      await moveToActive();

      expect(await notifications.unreadCount(moderator)).toBe(0);
    });

    it('sends one notification to somebody who follows both the entry and the board', async () => {
      // Two reasons to hear about it is still one thing that happened.
      await favourite(follower);
      await follows(follower);

      await moveToActive();

      expect(await notifications.unreadCount(follower)).toBe(1);
    });

    describe('the endpoint', () => {
      let auth: { session: string; csrf: string; csrfToken: string };

      beforeAll(async () => {
        ctx.patreon.identity = {
          ...ctx.patreon.identity,
          // A dedicated identity: signing in re-syncs that user's memberships, and reusing a
          // fixture here emptied the very membership another test relies on as its control.
          patreonUserId: 'bm-api',
          memberships: [],
        };
        const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
        const state = new URL(start.headers.location).searchParams.get('state') as string;
        const res = await request(ctx.app.getHttpServer())
          .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
          .set('Cookie', pickCookie(start, 'pp_oauth_state'))
          .expect(302);
        const csrf = pickCookie(res, 'pp_csrf').split(';')[0];
        auth = {
          session: pickCookie(res, 'pp_session'),
          csrf,
          csrfToken: csrf.split('=').slice(1).join('='),
        };
      });

      const call = (method: 'post' | 'delete', id: string, slug = 'move-co') =>
        request(ctx.app.getHttpServer())
          [method](`/api/v1/creators/${slug}/recommendations/${id}/follow`)
          .set('Cookie', [auth.session, auth.csrf])
          .set('x-csrf-token', auth.csrfToken);

      it('follows and unfollows an entry', async () => {
        await call('post', recId).expect(204);
        expect(await ctx.prisma.entryFollow.count({ where: { recommendationId: recId } })).toBe(1);

        await call('delete', recId).expect(204);
        expect(await ctx.prisma.entryFollow.count({ where: { recommendationId: recId } })).toBe(0);
      });

      it('treats following twice as following once', async () => {
        await call('post', recId).expect(204);
        await call('post', recId).expect(204);

        expect(await ctx.prisma.entryFollow.count({ where: { recommendationId: recId } })).toBe(1);
      });

      it('does not mind unfollowing something never followed', async () => {
        // A 404 here would tell an unfollowed reader whether the entry exists.
        await call('delete', recId).expect(204);
      });

      it('tells the board whether this reader follows an entry', async () => {
        // Without it the control forgets on every reload, and a feature that forgets looks broken
        // rather than unset.
        const board = () =>
          request(ctx.app.getHttpServer())
            .get('/api/v1/creators/move-co/recommendations')
            .set('Cookie', [auth.session, auth.csrf]);

        const before = (await board().expect(200)).body.items.find(
          (i: { id: string }) => i.id === recId,
        );
        expect(before.following).toBe(false);

        await call('post', recId).expect(204);

        const after = (await board().expect(200)).body.items.find(
          (i: { id: string }) => i.id === recId,
        );
        expect(after.following).toBe(true);
      });

      it('does not report somebody else’s follow as this reader’s', async () => {
        await ctx.prisma.entryFollow.create({
          data: { userId: stranger, recommendationId: recId },
        });

        const entry = (
          await request(ctx.app.getHttpServer())
            .get('/api/v1/creators/move-co/recommendations')
            .set('Cookie', [auth.session, auth.csrf])
            .expect(200)
        ).body.items.find((i: { id: string }) => i.id === recId);

        expect(entry.following).toBe(false);
      });

      it('404s an entry on another board', async () => {
        // An entry id alone says nothing about which board owns it, and following one on a board
        // this reader cannot see would confirm it exists.
        const elsewhere = await ctx.prisma.creator.create({
          data: {
            patreonCampaignId: 'bm-follow-other',
            ownerUserId: owner,
            displayName: 'Elsewhere',
            slug: 'bm-follow-other',
            policy: { create: {} },
            staff: { create: { userId: owner, role: 'OWNER' } },
          },
        });
        const theirs = await ctx.prisma.recommendation.create({
          data: {
            creatorId: elsewhere.id,
            submittedByUserId: owner,
            type: 'MOVIE',
            customTitle: 'Not Here',
            normalizedTitle: 'not here',
          },
        });

        await call('post', theirs.id).expect(404);

        expect(await ctx.prisma.entryFollow.count({ where: { recommendationId: theirs.id } })).toBe(
          0,
        );
        await ctx.prisma.creator.delete({ where: { id: elsewhere.id } });
      });
    });

    it('stops once they unfollow', async () => {
      await follows(stranger);
      await ctx.prisma.entryFollow.delete({
        where: { userId_recommendationId: { userId: stranger, recommendationId: recId } },
      });

      await moveToActive();

      expect(await notifications.unreadCount(stranger)).toBe(0);
    });
  });

  it('says nothing to someone who does not follow the board', async () => {
    await moveToActive();

    expect(await notifications.unreadCount(stranger)).toBe(0);
  });

  it('never tells a follower who may not read the board', async () => {
    // The test this feature turns on. A SUBSCRIBERS_ONLY board can be favourited by somebody who
    // never pledged — a favourite is a bookmark, not an entitlement — and the payload carries the
    // entry's title. A notification here hands out precisely what the policy withholds.
    await setVisibility('SUBSCRIBERS_ONLY');
    await favourite(lapsedFollower);
    await favourite(follower);

    await moveToActive();

    expect(await notifications.unreadCount(lapsedFollower)).toBe(0);
    // ...and the check is not simply refusing everyone, which would pass the line above for the
    // wrong reason entirely.
    expect(await notifications.unreadCount(follower)).toBe(1);
  });

  it('does not tell the submitter twice about their own entry', async () => {
    // They already receive ENTRY_STATUS_CHANGED. Two notifications for one move reads as a bug,
    // because it is one.
    await favourite(patron);

    await moveToActive();

    const { items } = await notifications.list(patron);
    expect(items.map((i) => i.type)).toEqual(['ENTRY_STATUS_CHANGED', 'ENTRY_STATUS_CHANGED']);
  });

  it('does not tell the moderator who made the move', async () => {
    await favourite(moderator);

    await moveToActive();

    expect(await notifications.unreadCount(moderator)).toBe(0);
  });

  it('writes nothing if the transaction it rides in rolls back', async () => {
    // Asked through the transaction rather than after it: an implementation that emits *after*
    // the write also leaves nothing behind when the transaction throws, so checking only the
    // empty table afterwards passes for the very implementation this test exists to reject.
    await favourite(follower);
    await actions.changeStatus(creatorId, recId, moderator, 'ACCEPTED');

    let seenInside = -1;
    const rollingBack = {
      recommendation: ctx.prisma.recommendation,
      creatorFavorite: ctx.prisma.creatorFavorite,
      creatorPolicy: ctx.prisma.creatorPolicy,
      $transaction: (fn: (tx: typeof ctx.prisma) => Promise<unknown>) =>
        ctx.prisma.$transaction(async (tx) => {
          await fn(tx as typeof ctx.prisma);
          seenInside = await tx.notification.count({ where: { userId: follower } });
          throw new Error('failed after the work was done');
        }),
    };
    const service = new ModerationActionsService(
      rollingBack as never,
      notifications,
      ctx.app.get(BoardFollowersService),
    );

    await expect(service.changeStatus(creatorId, recId, moderator, 'ACTIVE')).rejects.toThrow(
      'failed after the work',
    );

    expect(seenInside).toBe(1);
    expect(await notifications.unreadCount(follower)).toBe(0);
  });
});
