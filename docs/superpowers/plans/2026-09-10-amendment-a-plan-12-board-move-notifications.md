# Following What Moves — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell a reader when something moves on a board they follow, and let them decide how much of that they want to hear.

**Architecture:** `CreatorFavorite` already is "boards I follow" and is already indexed by `creatorId` — the exact index a fan-out needs. Status changes already emit inside the moderation transaction. This adds a second audience to that emit, a per-board preference to filter it, and the visibility resolution that keeps a follower from learning about an entry they may not read.

**Tech Stack:** NestJS 10, Prisma 5 + Postgres 16, React 18 + Vite, Jest + Testcontainers, Vitest + RTL.

## Global Constraints

- **Free tier only.** No new dependency. **In-app only** — there is no mailer in this project, and Amendment A.4 records email as a blocking question for the engineer, not something to answer by installing something.
- **A notification may never carry what its recipient cannot read.** `staff.service.ts` already deletes a removed moderator's notifications for exactly this reason; the same rule binds here, and here it is the whole difficulty.
- **Premium gates granularity, never notification itself.** Amendment A.1 lists "being notified" among the things free forever.
- **Emit inside the transaction.** A notification claiming a move that rolled back is worse than no notification. `notification-triggers.int-spec.ts` already holds this line and its test must keep passing.

---

## The problem

`ENTRY_STATUS_CHANGED` tells the submitter their own entry moved. Nobody else hears anything. A reader who follows six boards to find out what those creators are actually watching has to open all six and compare against memory.

## Decisions this plan settles

- **A new type, `ENTRY_MOVED`, rather than widening `ENTRY_STATUS_CHANGED`.** They answer different questions — "your entry moved" versus "something moved on a board you follow" — and the submitter must not receive both for one move.
- **Default is `ACTIVE` and `COMPLETED` only.** Those are the moments a follower cares about: started, and finished. `PENDING → ACCEPTED` is board administration, and defaulting to it would make the first login a firehose and the feature something people switch off before they configure it.
- **`User.premiumUntil` is added now, nullable, and nothing sets it.** Building the gate closed costs one column; adding it later means taking granularity away from people who already had it, which Amendment A.2 rules out by name. Until billing exists, nobody is premium and everybody gets the default.
- **Visibility resolves per follower, at fan-out.** Not at read. A row that exists but is filtered on display is still a row containing a title, on a board the reader may not be entitled to see.

## Scope

**In:** `ENTRY_MOVED`; fan-out to followers with visibility resolution; `BoardNotificationPreference`; the default rule; the preferences UI; `premiumUntil` as an unset column.

**Out, with reasons:**
- *Title and tag filtering.* Amendment A.4 leaves per-reader-versus-creator-themes **OPEN**. Building it either way now picks that answer by accident.
- *Email digests.* Blocked on A.4's provider question.
- *Coalescing beyond the per-move cap in Task 1.* Real follower counts do not exist yet, and A.4 says the volume question is settled with numbers rather than guesses.

## File Structure

- `apps/api/prisma/schema.prisma` + migration — `ENTRY_MOVED`, `BoardNotificationPreference`, `User.premiumUntil`.
- `apps/api/src/notifications/board-followers.service.ts` — who hears about a move. New file; this is the whole risk of the feature and does not belong inside the moderation flow.
- `apps/api/src/notifications/notification-preferences.service.ts` + controller — read and write the preference.
- `apps/api/src/moderation/moderation-actions.service.ts` — one added call.
- `apps/web/src/routes/NotificationSettings.tsx` + test.
- `apps/api/test/board-move-notifications.int-spec.ts`.

---

### Task 1: Who hears about a move

**Files:**
- Create: `apps/api/src/notifications/board-followers.service.ts`
- Create: `apps/api/test/board-move-notifications.int-spec.ts`
- Modify: `apps/api/prisma/schema.prisma`, new migration, `moderation-actions.service.ts`

**Interfaces:**
- Consumes: `can` and `Viewer` from `../access/capability`, `NotificationsService.emit`, `PrismaService`.
- Produces: `BoardFollowersService.audienceFor(tx, creatorId, toStatus, excludeUserIds): Promise<string[]>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('tells a follower when an entry reaches ACTIVE', async () => {
  await favourite(follower);
  await actions.changeStatus(creatorId, recId, moderator, 'ACCEPTED');
  await actions.changeStatus(creatorId, recId, moderator, 'ACTIVE');

  const { items } = await notifications.list(follower);
  expect(items).toHaveLength(1);
  expect(items[0].type).toBe('ENTRY_MOVED');
  expect(items[0].payload).toMatchObject({ status: 'ACTIVE', title: 'Cowboy Bebop' });
});

it('says nothing to a follower for a move to ACCEPTED by default', async () => {
  // Board administration, not news. Defaulting to it makes the first login a firehose.
  await favourite(follower);
  await actions.changeStatus(creatorId, recId, moderator, 'ACCEPTED');
  expect(await notifications.unreadCount(follower)).toBe(0);
});

it('says nothing to someone who does not follow the board', async () => {
  await actions.changeStatus(creatorId, recId, moderator, 'ACCEPTED');
  await actions.changeStatus(creatorId, recId, moderator, 'ACTIVE');
  expect(await notifications.unreadCount(stranger)).toBe(0);
});

it('never tells a follower who may not read the board', async () => {
  // THE test. A SUBSCRIBERS_ONLY board can be favourited by someone who does not pledge — the
  // favourite is a bookmark, not an entitlement. The payload carries the entry title, so a
  // notification here hands out exactly what the visibility policy withholds.
  await setVisibility('SUBSCRIBERS_ONLY');
  await favourite(lapsedFollower); // favourited, no active membership
  await actions.changeStatus(creatorId, recId, moderator, 'ACCEPTED');
  await actions.changeStatus(creatorId, recId, moderator, 'ACTIVE');

  expect(await notifications.unreadCount(lapsedFollower)).toBe(0);
});

it('does not tell the submitter twice about their own entry', async () => {
  // They already get ENTRY_STATUS_CHANGED. Two notifications for one move reads as a bug.
  await favourite(patron); // the submitter also follows the board
  await actions.changeStatus(creatorId, recId, moderator, 'ACCEPTED');
  await actions.changeStatus(creatorId, recId, moderator, 'ACTIVE');

  const { items } = await notifications.list(patron);
  expect(items.map((i) => i.type)).toEqual(['ENTRY_STATUS_CHANGED', 'ENTRY_STATUS_CHANGED']);
});

it('does not tell the moderator who made the move', async () => {
  await favourite(moderator);
  await actions.changeStatus(creatorId, recId, moderator, 'ACCEPTED');
  await actions.changeStatus(creatorId, recId, moderator, 'ACTIVE');
  expect(await notifications.unreadCount(moderator)).toBe(0);
});

it('writes nothing if the transaction it rides in rolls back', async () => {
  // The same property notification-triggers.int-spec.ts already holds for the submitter, asked
  // through the transaction rather than after it — an implementation that emits afterwards also
  // leaves nothing behind when the transaction throws, so checking only the empty table passes
  // for the very implementation this test exists to reject.
  ...
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && pnpm test -- board-move-notifications`
Expected: FAIL — `ENTRY_MOVED` is not a member of `NotificationType`.

- [ ] **Step 3: Schema and migration**

```prisma
enum NotificationType {
  ENTRY_STATUS_CHANGED
  ENTRY_FLAGGED
  ENTRY_MOVED
  TICKET_RAISED
  TICKET_RESOLVED
}
```

`User.premiumUntil DateTime?` in the same migration. Additive only — no `DROP COLUMN`, no `SET NOT NULL`, so `migration-safety.e2e-spec.ts` stays green without an exemption.

- [ ] **Step 4: Implement the audience**

```ts
/**
 * Who hears that something moved.
 *
 * Visibility is resolved here, per follower, rather than filtered on display: a stored
 * notification carries the entry's title, so a row that exists for someone who may not read the
 * board has already leaked whatever the policy was protecting. Favouriting is a bookmark, not an
 * entitlement — a SUBSCRIBERS_ONLY board can be favourited by somebody who never pledged.
 */
async audienceFor(
  tx: Prisma.TransactionClient,
  creatorId: string,
  toStatus: RecommendationStatus,
  exclude: string[],
): Promise<string[]> {
  const followers = await tx.creatorFavorite.findMany({
    where: { creatorId, userId: { notIn: exclude } },
    select: {
      userId: true,
      user: {
        select: {
          premiumUntil: true,
          memberships: { where: { creatorId }, select: { amountCents: true, isActivePatron: true } },
          staffRoles: { where: { creatorId }, select: { role: true, permissions: true } },
          notificationPreferences: { where: { creatorId }, select: { statuses: true } },
        },
      },
    },
  });
  const policy = await this.policyFor(tx, creatorId);

  return followers
    .filter((f) => wants(f.user, toStatus))
    // The same pure resolver the guard uses. Never a second implementation of "may they see it".
    .filter((f) => can('VIEW', viewerFrom(f.user), policy))
    .map((f) => f.userId);
}
```

- [ ] **Step 5: Run to verify they pass**

- [ ] **Step 6: Mutation-check**

Each must fail, and only its own test:
- Drop the `can('VIEW', ...)` filter → the `SUBSCRIBERS_ONLY` test fails.
- Drop `exclude` → the submitter and moderator tests fail.
- Default to every status → the ACCEPTED test fails.
- Emit after the transaction rather than inside → the rollback test fails.

- [ ] **Step 7: Commit**

### Task 2: The preference

**Files:**
- Create: `apps/api/src/notifications/notification-preferences.service.ts`, controller, DTO
- Modify: schema — `BoardNotificationPreference`

**Interfaces:**
- Produces: `GET|PUT /creators/:slug/notification-preferences`, body `{ statuses: RecommendationStatus[] }`.

```prisma
// Absent means the default; an empty array means silence. They are different answers and must
// stay distinguishable — collapsing them makes "I want nothing from this board" indistinguishable
// from "I have not chosen", and any later change to the default would silently un-silence people.
model BoardNotificationPreference {
  userId    String   @db.Uuid
  creatorId String   @db.Uuid
  statuses  RecommendationStatus[]
  updatedAt DateTime @updatedAt
  @@id([userId, creatorId])
  @@index([creatorId])
}
```

- [ ] **Step 1: Failing tests** — a set is stored and honoured; an empty set silences the board; an absent row uses the default; a non-premium reader is refused a custom set with 402; one board's preference does not affect another's; a preference for a board they cannot see is a 404 (not 403, per the standing rule).
- [ ] **Step 2: Run, verify they fail.**
- [ ] **Step 3: Implement.** Replace the set outright rather than patching it — the page edits checkboxes, and a partial update races two tabs into a merge nobody asked for. `staff.service.ts#setPermissions` carries the same reasoning.
- [ ] **Step 4: Run, verify they pass.**
- [ ] **Step 5: Mutation-check** — treating an empty array as absent must fail the silence test; dropping the premium check must fail the 402 test; dropping `creatorId` scope must fail the cross-board test.
- [ ] **Step 6: Commit.**

### Task 3: The page

**Files:**
- Create: `apps/web/src/routes/NotificationSettings.tsx` + test
- Modify: `apps/web/src/api/types.ts`, `use-moderation.ts`, `NotificationsPage.tsx`

- [ ] **Step 1: Failing tests** — the default is shown as the default rather than as an empty choice; checking a column stores the whole set; a non-premium reader sees the controls **disabled with the reason**, not hidden; silencing a board is one action and says what it did.
- [ ] **Step 2: Run, verify they fail.**
- [ ] **Step 3: Implement.** Disabled-with-a-reason rather than hidden: this is the one place premium is visible, and a control that vanishes teaches nothing. It is also the opposite of the `EDIT_ENTRIES` rule in plan 10 — there, a hidden control is right because the API refuses it; here, the reader is *eligible to buy* the thing.
- [ ] **Step 4: Run, verify they pass.**
- [ ] **Step 5:** Full verification set, plus one e2e journey: follow a board, a moderator moves an entry to Now Playing, the bell shows it.
- [ ] **Step 6: Commit.**

## Known risks

- **Fan-out is write-amplified.** One move on a board with a thousand followers is a thousand rows. Fine at current scale, and Amendment A.4 says the volume question gets settled with real numbers rather than a guess — but this is the plan that makes it possible to reach that scale, so the index on `CreatorFavorite(creatorId)` is load-bearing and the query must not become an N+1 over memberships.
- **`premiumUntil` is dead weight until billing exists.** Deliberate: the gate is cheaper to build closed than to add later, and adding it later takes granularity away from people who already had it.
- **The visibility filter duplicates a decision the guard also makes.** It calls the same pure `can()` rather than reimplementing it, but the two now have to stay in step — if a new visibility mode is added, this is a second place it must be handled, and nothing will fail loudly if it is not.
