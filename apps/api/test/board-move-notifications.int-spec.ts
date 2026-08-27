import { ModerationActionsService } from '../src/moderation/moderation-actions.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { AuthTestContext, startAuthApp } from './support/auth-app';
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
    await ctx.prisma.boardNotificationPreference.deleteMany();
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

    await actions.changeStatus(creatorId, recId, moderator, 'COMPLETED');

    const folded = await ctx.prisma.notification.findFirstOrThrow({
      where: { userId: follower, type: 'ENTRY_MOVED' },
    });
    expect(folded.id).toBe(first.id);
    expect(folded.createdAt.getTime()).toBeGreaterThan(first.createdAt.getTime());
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
