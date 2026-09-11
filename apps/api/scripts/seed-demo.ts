/**
 * Seeds a board worth playing with.
 *
 * Idempotent: every write is an upsert keyed on something stable, so running it twice against a
 * live stack is a no-op rather than a second copy of everything. That matters because the demo
 * stack keeps its volume between runs — a playtester who restarts it should find their board
 * where they left it, not doubled.
 *
 * Run through the demo stack (`docker compose -f docker-compose.demo.yml up`), which invokes it
 * once the migrations have landed.
 */
import { PrismaClient, RecommendationStatus } from '@prisma/client';

const prisma = new PrismaClient();

const CAMPAIGN = 'demo-campaign';

/** Kept in step with the personas the Patreon stub offers at `/__be/<key>`. */
const PEOPLE = {
  ada: { patreonUserId: 'demo-ada', fullName: 'Ada Lovelace' },
  mo: { patreonUserId: 'demo-mo', fullName: 'Mo Ferran' },
  bea: { patreonUserId: 'demo-bea', fullName: 'Bea Okonjo' },
  cal: { patreonUserId: 'demo-cal', fullName: 'Cal Nguyen' },
  dee: { patreonUserId: 'demo-dee', fullName: 'Dee Alvarez' },
} as const;

async function main() {
  const users: Record<keyof typeof PEOPLE, string> = {} as never;
  for (const [key, person] of Object.entries(PEOPLE)) {
    const user = await prisma.user.upsert({
      where: { patreonUserId: person.patreonUserId },
      create: person,
      update: { fullName: person.fullName },
      select: { id: true },
    });
    users[key as keyof typeof PEOPLE] = user.id;
  }

  const creator = await prisma.creator.upsert({
    where: { patreonCampaignId: CAMPAIGN },
    create: {
      patreonCampaignId: CAMPAIGN,
      ownerUserId: users.ada,
      displayName: 'Ada Watches Things',
      slug: 'ada-watches-things',
      policy: { create: { viewVisibility: 'PUBLIC' } },
      // Claiming a board writes an OWNER staff row; a seeded board without one is a board the
      // app cannot produce.
      staff: { create: { userId: users.ada, role: 'OWNER' } },
    },
    update: {},
    select: { id: true },
  });
  const creatorId = creator.id;

  const tiers = [
    { patreonTierId: 'demo-tier-basic', title: 'Sidekick', amountCents: 500, order: 0 },
    // Worth three votes, so the demo shows weighted voting rather than merely containing it: with
    // every tier at the default of 1 the weighted score equals the raw count and "Top rated" is a
    // popularity sort, which is the one thing this mechanic exists not to be.
    {
      patreonTierId: 'demo-tier-plus',
      title: 'Producer',
      amountCents: 1500,
      order: 1,
      voteWeight: 3,
    },
  ];
  for (const tier of tiers) {
    await prisma.tier.upsert({
      where: { creatorId_patreonTierId: { creatorId, patreonTierId: tier.patreonTierId } },
      create: { ...tier, creatorId },
      // `voteWeight` included deliberately, and only because this is the demo seed: reseeding is
      // how the demo returns to the state the walkthrough describes, so a weight a play-tester
      // changed should go back. Anywhere else, overwriting a creator's own tuning on a routine
      // sync would be the bug — which is exactly what omitting a field from an update branch
      // caused for `overview`, in the other direction.
      update: {
        title: tier.title,
        amountCents: tier.amountCents,
        order: tier.order,
        voteWeight: tier.voteWeight ?? 1,
      },
    });
  }

  await prisma.creatorStaff.upsert({
    where: { creatorId_userId: { creatorId, userId: users.mo } },
    create: { creatorId, userId: users.mo, role: 'MOD' },
    update: {},
  });

  // Dee is deliberately a former patron: the read/upvote/submit split is one of the things worth
  // playing with, and it is invisible if everyone can do everything.
  // Bound to a Tier, not merely to an amount. A membership with no `currentTierId` makes every
  // upvote record no tier, and `weightedScore` then equals the raw count no matter how the weights
  // are set — so weighted voting, which is a shipped mechanic, was invisible in this demo whatever
  // anyone did. Signing in binds it from Patreon; the seed has to do the same or the entries it
  // creates carry votes worth nothing in particular.
  const tierByTitle = new Map(
    (await prisma.tier.findMany({ where: { creatorId }, select: { id: true, title: true } })).map(
      (tier) => [tier.title, tier.id],
    ),
  );
  const memberships = [
    {
      userId: users.bea,
      amountCents: 500,
      isActivePatron: true,
      currentTierId: tierByTitle.get('Sidekick') ?? null,
    },
    {
      userId: users.cal,
      amountCents: 1500,
      isActivePatron: true,
      currentTierId: tierByTitle.get('Producer') ?? null,
    },
    // No tier, because there is no pledge: a lapsed patron is entitled to nothing.
    { userId: users.dee, amountCents: 0, isActivePatron: false, currentTierId: null },
  ];
  for (const membership of memberships) {
    await prisma.membership.upsert({
      where: { userId_creatorId: { userId: membership.userId, creatorId } },
      create: { ...membership, creatorId },
      update: {
        amountCents: membership.amountCents,
        isActivePatron: membership.isActivePatron,
        currentTierId: membership.currentTierId,
      },
    });
  }

  const entries: Array<{
    title: string;
    by: keyof typeof PEOPLE;
    status: RecommendationStatus;
    description?: string;
    upvotes?: Array<keyof typeof PEOPLE>;
  }> = [
    {
      title: 'Spirited Away',
      by: 'bea',
      status: 'ACTIVE',
      description: 'Starting here — everyone says it is the one to begin with.',
      upvotes: ['cal', 'dee'],
    },
    {
      title: 'My Neighbor Totoro',
      by: 'cal',
      status: 'ACCEPTED',
      description: 'Gentler than the others. Good palate cleanser.',
      upvotes: ['bea'],
    },
    {
      title: 'Princess Mononoke',
      by: 'bea',
      status: 'PENDING',
      upvotes: ['cal', 'dee'],
      // Cal upvoted this one before he upgraded, so it is still worth what a Sidekick vote is
      // worth. That is the whole case the ratchet exists for, and without a single stale vote
      // anywhere the my-votes page has nothing to offer and the feature cannot be seen.
      votedBefore: ['cal'],
    },
    { title: 'Perfect Blue', by: 'cal', status: 'PENDING', upvotes: ['bea'] },
    { title: 'Paprika', by: 'dee', status: 'PENDING' },
    { title: 'Grave of the Fireflies', by: 'bea', status: 'COMPLETED' },
    {
      title: 'Ghost in the Shell',
      by: 'cal',
      status: 'REJECTED',
      description: 'Covered on the other channel already.',
    },
  ];

  for (const entry of entries) {
    const normalizedTitle = entry.title.toLowerCase();
    // Find-then-create rather than upsert: the de-dupe index is a hand-written *partial* unique
    // index, which Prisma does not expose as a compound key. Nothing else writes this board while
    // the seed runs, so the race an upsert would close cannot happen here.
    const existing = await prisma.recommendation.findFirst({
      where: { creatorId, normalizedTitle, type: 'EXTERNAL_LINK' },
      select: { id: true },
    });
    const row = existing
      ? await prisma.recommendation.update({
          where: { id: existing.id },
          data: { status: entry.status },
          select: { id: true },
        })
      : await prisma.recommendation.create({
          data: {
            creatorId,
            submittedByUserId: users[entry.by],
            type: 'EXTERNAL_LINK',
            customTitle: entry.title,
            normalizedTitle,
            description: entry.description ?? null,
            status: entry.status,
          },
          select: { id: true },
        });

    for (const voter of entry.upvotes ?? []) {
      // The tier they actually pledge at, as the real path records — a vote carries a reference to
      // its tier so a creator rebalancing changes what already-cast votes are worth. Without it
      // every demo vote would weigh 1 and the board would never show tier weighting at all.
      const membership = await prisma.membership.findUnique({
        where: { userId_creatorId: { userId: users[voter], creatorId } },
        select: { currentTierId: true },
      });
      // A vote cast before this patron upgraded keeps the cheaper tier it was cast at. Nothing
      // backfills it — that is the point of the ratchet, which offers to lift it on request.
      const castAt = (entry.votedBefore ?? []).includes(voter)
        ? (tierByTitle.get('Sidekick') ?? null)
        : (membership?.currentTierId ?? null);
      await prisma.upvote.upsert({
        where: {
          recommendationId_userId: { recommendationId: row.id, userId: users[voter] },
        },
        create: {
          recommendationId: row.id,
          userId: users[voter],
          tierId: castAt,
        },
        update: { tierId: castAt },
      });
    }
    /*
     * Both derived columns, not one of them.
     *
     * `upvoteCount` and `weightedScore` are maintained together by `upvotes.service` — it
     * increments and decrements both. Seeding only the first left every weighted score at zero,
     * so the board's own "most upvoted" sort found every row tied and fell through to `createdAt`.
     * The product was fine; the demo was lying, and a play-tester has no way to tell those apart.
     *
     * Weighted from the tier each voter actually pledges at, exactly as the service does, so the
     * demo shows the real behaviour: a higher tier's vote counts for more.
     */
    const upvotes = await prisma.upvote.findMany({
      where: { recommendationId: row.id },
      select: { tier: { select: { voteWeight: true } } },
    });
    await prisma.recommendation.update({
      where: { id: row.id },
      data: {
        upvoteCount: upvotes.length,
        weightedScore: upvotes.reduce((total, vote) => total + (vote.tier?.voteWeight ?? 1), 0),
      },
    });
  }

  // Something for the review queue to hold, so it is not an empty screen on first look.
  const reported = await prisma.recommendation.findFirst({
    where: { creatorId, customTitle: 'Paprika' },
    select: { id: true },
  });
  if (reported) {
    await prisma.flag.upsert({
      where: {
        recommendationId_flaggedByUserId: {
          recommendationId: reported.id,
          flaggedByUserId: users.bea,
        },
      },
      create: {
        recommendationId: reported.id,
        flaggedByUserId: users.bea,
        reason: 'OFF_TOPIC',
        note: 'Pretty sure this one was already covered.',
      },
      update: {},
    });
  }

  const active = await prisma.recommendation.findFirst({
    where: { creatorId, customTitle: 'Spirited Away' },
    select: { id: true },
  });
  if (active) {
    const notes = [
      { kind: 'TIMELINE' as const, body: 'Watch-along scheduled for Friday.' },
      { kind: 'NOTE' as const, body: 'Check whether the dub or the sub reads better on stream.' },
    ];
    for (const note of notes) {
      const exists = await prisma.creatorNote.findFirst({
        where: { recommendationId: active.id, body: note.body },
        select: { id: true },
      });
      if (!exists) {
        await prisma.creatorNote.create({
          data: {
            recommendationId: active.id,
            authorUserId: users.ada,
            body: note.body,
            kind: note.kind,
            plannedFor: note.kind === 'TIMELINE' ? new Date('2026-09-04T19:00:00Z') : null,
          },
        });
      }
    }
  }

  // One of each action, so the blocklist is something you can see working rather than read about.
  for (const word of [
    { pattern: 'ganondorf', action: 'BLOCK' as const },
    { pattern: 'spoiler', action: 'FLAG' as const },
  ]) {
    await prisma.creatorBlockword.upsert({
      where: { creatorId_pattern: { creatorId, pattern: word.pattern } },
      create: { creatorId, ...word },
      update: { action: word.action },
    });
  }

  // ---------------------------------------------------------------------------------------
  // Everything below exists so the features built after the first demo are visible rather than
  // described. A feature nobody can reach on the demo stack is a feature nobody reviews.
  // ---------------------------------------------------------------------------------------

  // Cal pays for premium. Without somebody who does, the expanded reaction palette, carrying a
  // list, syncing settings and choosing which moves reach you are all invisible — every gate is
  // built closed and there is nothing to open them with.
  await prisma.user.update({
    where: { id: users.cal },
    data: { premiumUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
  });
  await prisma.subscription.upsert({
    where: { userId: users.cal },
    create: {
      userId: users.cal,
      provider: 'demo',
      providerSubscriptionId: 'demo-sub-cal',
      providerCustomerId: 'demo-cus-cal',
      providerOrderId: 'demo-order-cal',
      status: 'ACTIVE',
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
    update: { status: 'ACTIVE' },
  });

  // A second board, because carrying a list across boards needs somewhere to carry it to — and
  // per-board notification settings mean little when there is only one board.
  const second = await prisma.creator.upsert({
    where: { patreonCampaignId: 'demo-campaign-two' },
    create: {
      patreonCampaignId: 'demo-campaign-two',
      ownerUserId: users.mo,
      displayName: 'Mo Reads Things',
      slug: 'mo-reads-things',
      policy: { create: { viewVisibility: 'PUBLIC' } },
      staff: { create: { userId: users.mo, role: 'OWNER' } },
    },
    update: {},
    select: { id: true },
  });
  for (const userId of [users.bea, users.cal]) {
    await prisma.membership.upsert({
      where: { userId_creatorId: { userId, creatorId: second.id } },
      create: { userId, creatorId: second.id, amountCents: 500, isActivePatron: true },
      update: { isActivePatron: true },
    });
  }
  // Following a board is what puts its news in your bell.
  for (const userId of [users.bea, users.cal]) {
    for (const boardId of [creatorId, second.id]) {
      await prisma.creatorFavorite.upsert({
        where: { userId_creatorId: { userId, creatorId: boardId } },
        create: { userId, creatorId: boardId },
        update: {},
      });
    }
  }

  // A board with nothing on it reads as broken rather than as a fresh start.
  const secondEntries = [
    { title: 'The Left Hand of Darkness', by: 'bea' as const, status: 'ACTIVE' as const },
    { title: 'Piranesi', by: 'cal' as const, status: 'PENDING' as const },
    { title: 'A Memory Called Empire', by: 'bea' as const, status: 'ACCEPTED' as const },
  ];
  for (const entry of secondEntries) {
    const normalizedTitle = entry.title.toLowerCase();
    const exists = await prisma.recommendation.findFirst({
      where: { creatorId: second.id, normalizedTitle, type: 'EXTERNAL_LINK' },
      select: { id: true },
    });
    if (!exists) {
      await prisma.recommendation.create({
        data: {
          creatorId: second.id,
          submittedByUserId: users[entry.by],
          type: 'EXTERNAL_LINK',
          customTitle: entry.title,
          normalizedTitle,
          status: entry.status,
        },
      });
    }
  }

  // Themes, so narrowing a board's news to what you care about has something to narrow by. They
  // hang off catalogue titles in production; here they are attached by hand.
  const themes: Record<string, string> = {};
  for (const name of ['Anime', 'Documentary', 'Long Watch']) {
    const theme = await prisma.theme.upsert({
      where: { creatorId_slug: { creatorId, slug: name.toLowerCase().replace(/ /g, '-') } },
      create: { creatorId, name, slug: name.toLowerCase().replace(/ /g, '-') },
      update: {},
      select: { id: true },
    });
    themes[name] = theme.id;
  }

  // Themes hang off a catalogue title, so an entry typed by hand carries none — which is exactly
  // the limitation the design records. Two of these entries are bound to a catalogue title here so
  // that narrowing by theme filters *something* rather than everything, and so the difference
  // between a themed entry and an untyped one is visible side by side.
  //
  // Overviews match what the catalogue stub serves for the same ids, so a title reached by
  // suggesting it and one seeded here describe themselves the same way. They are for reading:
  // the embed job builds its passage from the name and aliases and never touches `overview`.
  // A few reactions, and one of them from the premium palette on purpose.
  //
  // With none at all, two real states of this control are invisible: a card carrying a count, and
  // the premium emotes appearing to a reader who cannot use them. The bar only shows an emote
  // somebody has used *or* one the reader could add — so a board with no reactions shows a
  // non-premium reader six greys and nothing else, and the difference premium makes is a thing
  // they have to be told rather than one they can see.
  const reactions: Array<[keyof typeof users, string, string]> = [
    ['cal', 'Spirited Away', '🍿'],
    ['bea', 'Spirited Away', '👍'],
    ['bea', 'Perfect Blue', '🔥'],
  ];
  for (const [who, title, emote] of reactions) {
    const target = await prisma.recommendation.findFirst({
      where: { creatorId, customTitle: title },
      select: { id: true },
    });
    if (!target) continue;
    const existing = await prisma.reaction.findFirst({
      where: { userId: users[who], recommendationId: target.id, emote },
      select: { id: true },
    });
    if (!existing) {
      await prisma.reaction.create({
        data: { userId: users[who], recommendationId: target.id, emote },
      });
    }
  }

  const themed: Array<[string, number, string[], string]> = [
    [
      'Spirited Away',
      129,
      ['Anime', 'Long Watch'],
      'A girl wanders into a world of spirits, and works in a bathhouse to win back her parents.',
    ],
    [
      'Perfect Blue',
      10494,
      ['Anime'],
      'A pop idol turns actress and loses her grip on which of her selves is real.',
    ],
    // Two more so the walkthrough's §7 can actually be followed. Folding is per reader per type,
    // so a reader narrowed to Anime needs *three* Anime entries to move before they see one item
    // saying "and 2 other changes" — with a single themed entry there is nothing to fold, and the
    // instruction reads as a broken feature rather than a thin fixture.
    [
      'Princess Mononoke',
      128,
      ['Anime'],
      'A prince cursed by a dying god walks into a war between a forest and an iron town.',
    ],
    [
      'My Neighbor Totoro',
      8392,
      ['Anime'],
      'Two sisters move to the country and meet the spirit who lives in the camphor tree.',
    ],
  ];
  for (const [title, tmdbId, names, overview] of themed) {
    const catalogTitle = await prisma.title.upsert({
      where: { tmdbId_mediaType: { tmdbId, mediaType: 'MOVIE' } },
      create: { tmdbId, mediaType: 'MOVIE', name: title, overview },
      // Set on an existing row too, so a demo seeded before this carries it after a reseed
      // rather than staying null until somebody happens to suggest the title again.
      //
      // `enrichedAt` is cleared for the same reason: the job only looks at titles that have never
      // been enriched, so a demo whose titles were enriched before aliases existed would never
      // acquire them. In a deployment the equivalent happens on its own — re-binding a title sets
      // this to null — but a demo is reseeded rather than re-suggested.
      update: { overview, enrichedAt: null },
      select: { id: true },
    });
    for (const name of names) {
      await prisma.titleTheme.upsert({
        where: { titleId_themeId: { titleId: catalogTitle.id, themeId: themes[name] } },
        create: { titleId: catalogTitle.id, themeId: themes[name] },
        update: {},
      });
    }
    await prisma.recommendation.updateMany({
      where: { creatorId, customTitle: title },
      data: { titleId: catalogTitle.id },
    });
  }

  // Bea hears about anime only, and about entries reaching Now Playing or Completed.
  await prisma.boardNotificationPreference.upsert({
    where: { userId_creatorId: { userId: users.bea, creatorId } },
    create: {
      userId: users.bea,
      creatorId,
      statuses: ['ACTIVE', 'COMPLETED'],
      themeIds: [themes.Anime],
    },
    update: {},
  });

  // A link somebody suggested, waiting for staff. The whole point of the candidate model is that
  // it does not appear on the card until a human says so, which needs one sitting there to see.
  const mononoke = await prisma.recommendation.findFirst({
    where: { creatorId, customTitle: 'Princess Mononoke' },
    select: { id: true },
  });
  if (mononoke) {
    await prisma.recommendationLink.upsert({
      where: {
        recommendationId_canonicalUrl: {
          recommendationId: mononoke.id,
          canonicalUrl: 'example.test/mononoke',
        },
      },
      create: {
        recommendationId: mononoke.id,
        url: 'https://example.test/mononoke',
        canonicalUrl: 'example.test/mononoke',
        submittedByUserId: users.bea,
        status: 'CANDIDATE',
      },
      update: {},
    });
    // ...and one already published, so the difference between the two is visible side by side.
    await prisma.recommendationLink.upsert({
      where: {
        recommendationId_canonicalUrl: {
          recommendationId: mononoke.id,
          canonicalUrl: 'example.test/mononoke-official',
        },
      },
      create: {
        recommendationId: mononoke.id,
        url: 'https://example.test/mononoke-official',
        label: 'Official page',
        canonicalUrl: 'example.test/mononoke-official',
        submittedByUserId: users.ada,
        status: 'PUBLISHED',
      },
      update: {},
    });
  }

  // Cal is waiting on one particular entry, whatever his theme choices say.
  //
  // Deliberately one he did *not* submit. A submitter already hears about their own entry through
  // ENTRY_STATUS_CHANGED and is excluded from the follower fan-out so they are not told twice —
  // so a seeded follow on his own suggestion would do nothing visible, and the feature would look
  // broken on the one screen anybody checks it on.
  const followed = await prisma.recommendation.findFirst({
    where: { creatorId, customTitle: 'Princess Mononoke' },
    select: { id: true },
  });
  if (followed) {
    await prisma.entryFollow.upsert({
      where: { userId_recommendationId: { userId: users.cal, recommendationId: followed.id } },
      create: { userId: users.cal, recommendationId: followed.id },
      update: {},
    });
  }

  // Cal narrows to Documentary, so the follow above is the *only* reason Princess Mononoke can
  // reach him — which is the rule worth seeing: a follow beats the theme narrowing.
  await prisma.boardNotificationPreference.upsert({
    where: { userId_creatorId: { userId: users.cal, creatorId } },
    create: {
      userId: users.cal,
      creatorId,
      statuses: ['ACTIVE', 'COMPLETED'],
      themeIds: [themes.Documentary],
    },
    update: {},
  });

  console.log(
    `Seeded ${entries.length} entries on /c/ada-watches-things, a second board at ` +
      `/c/mo-reads-things, and premium for Cal.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
