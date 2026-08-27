# Fan-out At Follower Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a move on a popular board cost a bounded number of statements and leave a follower with one useful notification per board rather than twenty.

**Architecture:** Coalesce `ENTRY_MOVED` per `(user, creator)` while unread, keeping the newest move as the headline and counting the rest. Two statements regardless of follower count — an `UPDATE` for those who already have one waiting, a `createMany` for everyone else.

**Tech Stack:** NestJS 10, Prisma 5 + Postgres 16, Jest + Testcontainers.

## Global Constraints

- **Free tier only.** No new dependency.
- **Still inside the moderation transaction.** Amendment A.4 and the existing rollback tests bind: a notification describing a move that rolled back is worse than none.
- **Bounded statements, not bounded rows.** A per-recipient query is the failure this plan exists to prevent, and it passes every correctness test while being unusable.

---

## The problem, in two halves

**Reader flooding.** A creator working through their queue moves eight entries to Now Playing in one sitting. Every follower gets eight bell items for one act of tidying, and the useful one — the most recent — is buried under seven older ones.

**Write amplification.** One move on a board with a thousand followers writes a thousand rows inside the transaction that also holds the entry's row lock.

These want different answers, and only the first is worth solving now. Amendment A.4 says the volume question gets settled with real numbers rather than a guess; Task 2 produces the numbers instead of inventing an architecture for load nobody has.

## Why not the flags answer

`flags.service.ts` already coalesces, by **dropping** anyone with an unread `ENTRY_FLAGGED` for that board. Its reasoning is explicit and correct *for reports*: the review queue is where reports are read, so the bell only has to say something is waiting.

That does not transfer. Here the notification **is** the product — a follower wants to know *what* started, not that something did. Pure suppression means a reader who checks weekly sees the first thing that moved that week and never the newest, which is the one they care about most.

## Decisions this plan settles

- **Coalesce by updating, not by dropping.** The waiting row is rewritten to the newest move, and a counter records how many it now stands for.
- **`groupCount` is a column, not a field inside `payload`.** Incrementing JSON needs a read-modify-write per row; a column increments in the same `UPDATE` that rewrites the payload, which is what keeps this to two statements.
- **Coalescing bumps `createdAt`.** The bell sorts on it, and the rewritten row is genuinely fresh news. A row that keeps its original timestamp sinks below older, less interesting items.
- **Grouped per board, not per board-and-status.** "Three things happened on this board" is a useful sentence; splitting it by destination column produces two half-empty groups and needs an index on a JSON field to do it.

## Scope

**In:** `groupCount`; coalescing on `ENTRY_MOVED`; the SPA rendering a group; a test at follower scale; measured numbers recorded in the design.

**Out, with reasons:**
- *An outbox and asynchronous fan-out.* The correct answer if the numbers demand it, and a large change to make on a guess. Task 2 decides.
- *Coalescing the other notification types.* `ENTRY_FLAGGED` and `TICKET_RAISED` already have an answer suited to them; changing it here would be scope creep with a moderation-visible blast radius.

---

### Task 1: Coalesce while unread

**Files:**
- Modify: `apps/api/prisma/schema.prisma` + migration, `apps/api/src/notifications/notifications.service.ts`
- Test: `apps/api/test/board-move-notifications.int-spec.ts`

**Interfaces:**
- Produces: `NotificationsService.emitCoalesced(tx, rows)` — same shape as `emit`, one row per recipient.

- [ ] **Step 1: Write the failing tests**

```ts
it('folds a second move into the one already waiting', async () => {
  await favourite(follower);
  await moveToActive();
  await actions.changeStatus(creatorId, recId, moderator, 'COMPLETED');

  const { items } = await notifications.list(follower);
  expect(items).toHaveLength(1);
  // The newest move is the headline: it is the one they care about most, and burying it under
  // an older one is the flooding this exists to prevent.
  expect(items[0].payload).toMatchObject({ status: 'COMPLETED' });
  expect(items[0].groupCount).toBe(2);
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

it('keeps one board’s group out of another’s', async () => { ... });

it('does not fold somebody else’s notification into this reader’s', async () => {
  // Two followers, one move each. A grouping keyed on the board alone rather than on
  // (reader, board) collapses everybody's into one row and hands it to whoever updated last.
  ...
});

it('leaves a flag notification alone', async () => {
  // ENTRY_FLAGGED has its own coalescing with different reasoning; this must not reach it.
  ...
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `cd apps/api && pnpm test -- board-move-notifications`
- [ ] **Step 3: Schema.** `groupCount Int @default(1)` on `Notification`, plus an index supporting the coalescing lookup: `@@index([creatorId, type, readAt, userId])`. Additive only — no exemption needed in `migration-safety.e2e-spec.ts`.
- [ ] **Step 4: Implement `emitCoalesced`.**

```ts
// Two statements regardless of how many people follow the board. A per-recipient read would
// pass every test above and fall over at the only scale that matters.
const folded = await tx.$executeRaw`
  UPDATE "Notification"
     SET payload = ${payload}::jsonb,
         "groupCount" = "groupCount" + 1,
         -- The bell sorts on createdAt, and this row is genuinely fresh news. Left alone, a
         -- rewritten notification sinks below older and less interesting ones.
         "createdAt" = now()
   WHERE "creatorId" = ${creatorId}::uuid
     AND "type" = 'ENTRY_MOVED'
     AND "readAt" IS NULL
     AND "userId" = ANY(${userIds}::uuid[])`;
```

Then `createMany` for the recipients that `UPDATE` did not touch, found with one `findMany` over the same predicate.

- [ ] **Step 5: Run to verify they pass.**
- [ ] **Step 6: Mutation-check.** Each must fail exactly one test: dropping `readAt IS NULL`; keying the `UPDATE` on `creatorId` alone without `userId`; leaving `groupCount` at 1; not bumping `createdAt`; letting the predicate match `ENTRY_FLAGGED`.
- [ ] **Step 7: Commit.**

### Task 2: Measure it, then decide

**Files:**
- Test: `apps/api/test/fanout-scale.int-spec.ts`
- Modify: `docs/superpowers/specs/2026-08-17-phase2-board-experience-design.md` (Amendment A.4's OPEN entry)

- [ ] **Step 1: Write the test.** Seed 500 followers, move an entry, and assert **every one of them gets exactly one notification** and a second move leaves 500 rows with `groupCount` 2. Correctness at a scale the other tests never reach.
- [ ] **Step 2: Count the statements.** Attach a Prisma query listener for the duration of one move and assert the count does not grow with follower count — run it at 50 and at 500 and compare. This is the assertion that actually forbids an N+1; the row counts above pass happily with one.
- [ ] **Step 3: Record the measured numbers** in Amendment A.4 in place of its OPEN entry, and state plainly whether an outbox is needed yet. A number in the design beats an opinion in a plan.
- [ ] **Step 4: Commit.**

### Task 3: The SPA says how many

**Files:**
- Modify: `apps/web/src/api/types.ts`, `NotificationsPage.tsx`, the bell dropdown, and their tests

- [ ] **Step 1: Failing tests.** A `groupCount` of 1 renders exactly as it does today; a group of 3 says so; the unread badge counts rows, not moves — one grouped notification is one unread thing.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5: Commit.**

## Known risks

- **`$executeRaw` bypasses Prisma's typing**, so a payload shape change will not fail the build here. The integration tests are the only thing holding it, which makes them load-bearing in a way the rest of the codebase's queries are not.
- **Bumping `createdAt` makes it a lie about creation.** It is now "last folded into", and any future feature reading it as an origin time will be wrong. Renaming it is a bigger change than this plan should make.
- **500 followers is not 50,000.** The test proves the shape, not the ceiling.
