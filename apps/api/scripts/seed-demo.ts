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
    { patreonTierId: 'demo-tier-plus', title: 'Producer', amountCents: 1500, order: 1 },
  ];
  for (const tier of tiers) {
    await prisma.tier.upsert({
      where: { creatorId_patreonTierId: { creatorId, patreonTierId: tier.patreonTierId } },
      create: { ...tier, creatorId },
      update: { title: tier.title, amountCents: tier.amountCents, order: tier.order },
    });
  }

  await prisma.creatorStaff.upsert({
    where: { creatorId_userId: { creatorId, userId: users.mo } },
    create: { creatorId, userId: users.mo, role: 'MOD' },
    update: {},
  });

  // Dee is deliberately a former patron: the read/upvote/submit split is one of the things worth
  // playing with, and it is invisible if everyone can do everything.
  const memberships = [
    { userId: users.bea, amountCents: 500, isActivePatron: true },
    { userId: users.cal, amountCents: 1500, isActivePatron: true },
    { userId: users.dee, amountCents: 0, isActivePatron: false },
  ];
  for (const membership of memberships) {
    await prisma.membership.upsert({
      where: { userId_creatorId: { userId: membership.userId, creatorId } },
      create: { ...membership, creatorId },
      update: { amountCents: membership.amountCents, isActivePatron: membership.isActivePatron },
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
    { title: 'Princess Mononoke', by: 'bea', status: 'PENDING', upvotes: ['cal', 'dee'] },
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
      await prisma.upvote.upsert({
        where: {
          recommendationId_userId: { recommendationId: row.id, userId: users[voter] },
        },
        create: { recommendationId: row.id, userId: users[voter] },
        update: {},
      });
    }
    const upvoteCount = await prisma.upvote.count({ where: { recommendationId: row.id } });
    await prisma.recommendation.update({ where: { id: row.id }, data: { upvoteCount } });
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

  console.log(`Seeded ${entries.length} entries on /c/ada-watches-things`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
