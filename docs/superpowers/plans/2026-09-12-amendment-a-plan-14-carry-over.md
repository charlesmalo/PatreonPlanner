# Carrying a List Across Boards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a patron put the same handful of titles in front of every creator they support, without doing it by hand and without becoming a mass-submission tool.

**Architecture:** A queue of deliveries, one row per `(reader, board, source entry)`, drained by the existing job tick. Every delivery goes through the **submit endpoint patrons already use** — the decisions about moderation, rate limiting and de-duplication are already made correctly there, and a second path would have to re-derive all of them.

**Tech Stack:** NestJS 10, Prisma 5 + Postgres 16, BullMQ (already wired), React 18, Jest + Testcontainers, Vitest + RTL.

## Global Constraints

- **Free tier only.** No new dependency; BullMQ and Redis are already here.
- **Never overrides a creator's limit.** One title to ten boards is one submission per board and exceeds nobody's quota. The queue waits at each board's own rate rather than pushing past it.
- **Reuse `SubmissionsService.submit`.** Not "call something similar" — the same method, so moderation-then-limit-then-de-dupe ordering, eligibility at delivery time, and the disclosure properties all come for free.
- **404 not 403** for a board the reader may not see, as everywhere else.

---

## The threat this has to avoid becoming

The submission limits are the whole abuse model: one per board per hour, five globally. A feature that fans a list out to ten boards is mechanically what those limits exist to prevent — and we would be *selling* it.

What makes it legitimate is that it never exceeds a **creator's** limit. Amendment A.2 already raised the global cap for premium, which is ours; this plan spends that headroom and nothing else. A delivery that would exceed a board's own rate limit **waits**; it does not push through and it does not fail.

## Decisions this plan settles

- **One delivery row per `(reader, board, source)`, unique.** Re-broadcasting the same list is idempotent rather than additive, and the row is where the outcome is reported back.
- **Rejection blocks a carry-over, though it does not block a person.** De-duplication filters on `notIn HIDDEN_STATUSES`, which contains `REJECTED`, so a refused title can be resubmitted by hand. That is right for someone exercising judgement and wrong for a queue, which would re-propose refused content on a schedule with no judgement to exercise.
- **Auto-submit is automatic; auto-vote is one click.** A submission is reviewed by a moderator before it reaches the board. An upvote is a direct tier-weighted input to the ordering with no gate, so a delivery that lands on an existing entry reports `ALREADY_PRESENT` and offers the reader a button — it never votes for them.
- **Carried-over entries are labelled**, so moderators can judge them as a class.
- **Creators can switch it off**, default on. Opt-in strands the feature at zero reach; the label plus the review queue is real protection.
- **Rate limiting leaves the delivery `PENDING`.** Burning it on a 429 would make the feature quietly lossy, which is the failure people notice last and trust least.

## Scope

**In:** the delivery model and its outcomes; the decision order; the drain job; `acceptsCarryOver`; `viaCarryOver`; the API to enqueue and read back; the dashboard that reports per-board outcomes.

**Out, with reasons:**
- *Carrying to boards the reader does not support at a submitting tier.* Entitlement is the creator's, and buying reach over their head is the one thing Amendment A forbids outright.
- *Automatic upvoting.* See above. The one-click path is the feature.
- *Carrying watch orders.* They have ordered children and a different submit shape; the value is in single titles and the complexity is not.

## File Structure

- `apps/api/prisma/schema.prisma` + migration — `CarryOverDelivery`, `CarryOverOutcome`, `CreatorPolicy.acceptsCarryOver`, `Recommendation.viaCarryOver`.
- `apps/api/src/carry-over/carry-over.service.ts` — enqueue, and the decision for one delivery.
- `apps/api/src/carry-over/carry-over.job.ts` — drains a batch on the existing tick.
- `apps/api/src/carry-over/carry-over.controller.ts` + DTO.
- `apps/web/src/routes/CarryOver.tsx` + test.

---

### Task 1: What happens to one delivery

**Files:**
- Create: `apps/api/src/carry-over/carry-over.service.ts`, `apps/api/test/carry-over.int-spec.ts`
- Modify: schema + migration

**Interfaces:**
- Consumes: `SubmissionsService.submit`, `PrismaService`.
- Produces: `CarryOverService.enqueue(userId, sourceIds, creatorIds)`, `CarryOverService.deliver(deliveryId)`.

- [x] **Step 1: Write the failing tests**

```ts
it('submits a title the board has not seen', async () => { ... outcome === 'SUBMITTED' ... });

it('reports an entry already on the board rather than voting for it', async () => {
  // An upvote is a direct, tier-weighted input to the ordering with no moderator between it and
  // the board. Casting one for content the reader never looked at is what this must not do.
  expect(delivery.outcome).toBe('ALREADY_PRESENT');
  expect(delivery.resultRecommendationId).toBe(existing.id);
  expect(await upvoteCount(existing.id)).toBe(0);
});

it('never re-proposes what a board already refused', async () => {
  // De-dupe ignores REJECTED so a person can resubmit after fixing whatever was wrong. A queue
  // has no judgement to exercise and would re-propose refused content on a schedule.
  await reject(existing.id);
  expect((await deliver()).outcome).toBe('REFUSED_BEFORE');
  expect(await entryCount(creatorId)).toBe(1);
});

it('respects a creator who has switched carry-over off', async () => { ... 'NOT_ACCEPTED' ... });

it('does not deliver to a board the reader may no longer submit to', async () => {
  // Eligibility is checked when the delivery runs, not when it was queued: a pledge can lapse
  // between the two, and the queue must not outlive the entitlement that authorised it.
  await lapse(patron);
  expect((await deliver()).outcome).toBe('NOT_ELIGIBLE');
});

it('waits rather than failing when the board’s rate limit is reached', async () => {
  // The creator's limit is theirs. Burning the delivery on a 429 makes the feature quietly
  // lossy, which is the failure people notice last and trust least.
  await exhaustLimit(patron, creatorId);
  expect((await deliver()).outcome).toBe('PENDING');
});

it('labels what it creates so moderators can judge it as a class', async () => { ... viaCarryOver ... });

it('is idempotent: broadcasting the same list twice queues one delivery', async () => { ... });
```

- [x] **Step 2: Run to verify they fail.**
- [x] **Step 3: Schema and migration.** Additive only.
- [x] **Step 4: Implement `deliver`, in this order** — the order *is* the design:
  1. creator switched it off → `NOT_ACCEPTED`
  2. refused here before → `REFUSED_BEFORE`
  3. `submit()` → `SUBMITTED`, or `duplicate: true` → `ALREADY_PRESENT`
  4. capability refusal → `NOT_ELIGIBLE`
  5. rate limited → stays `PENDING`
- [x] **Step 5: Run to verify they pass.**
- [x] **Step 6: Mutation-check.** Each fails exactly one test: dropping the rejection check; auto-upvoting on `ALREADY_PRESENT`; treating a 429 as failure; ignoring `acceptsCarryOver`; checking eligibility at enqueue instead of delivery.
- [x] **Step 7: Commit.**

### Task 2: Draining the queue

- [x] **Step 1: Failing tests** — a batch is bounded; a delivery that throws does not stop the batch; a `PENDING` left by a rate limit is retried on the next tick; a processed delivery is not processed twice.
- [x] **Step 2–4:** Run, implement `CarryOverJob.runOnce()` on the existing tick, run.
- [x] **Step 5: Commit.**

### Task 3: Asking for it, and seeing what happened

- [x] **Step 1: Failing tests** — `POST /carry-over` enqueues from the reader's own entries only; a source that is not theirs is refused; the dashboard groups outcomes per board; `ALREADY_PRESENT` offers one-click upvote and casting it works.
- [x] **Step 2–4:** Run, implement, run.
- [x] **Step 5:** Full verification, plus an e2e journey: broadcast to a second board, the entry appears there labelled.
- [x] **Step 6: Commit.**

## What it found

**`SubmissionsService.submit` does not check the SUBMIT capability.** The guard on the controller
does, and a queue calling the service walks straight past it — a test caught this delivering to a
board whose tier gate the reader did not meet. This plan had assumed reusing `submit` made
eligibility come for free. It does not, and the same would be true of anything else that calls the
service directly. Now resolved explicitly with the same pure `can()` the guard uses.

**Two drain mutations survived the first pass.** The batch bound had nothing asserting it. And the
guard against re-delivering a settled row looked untested, because the obvious assertion — no
duplicate entry — passes without it: de-duplication catches the second submit. The real damage is
rewriting a settled outcome, so `SUBMITTED` becomes `ALREADY_PRESENT` and the dashboard tells the
reader their title was already there when they are the one who put it there.

**Prisma does not accept `/** */` comments**, only `//` and `///`. Worth knowing before writing a
schema block in the house style.

## Known risks

- **This is the feature most likely to annoy a creator**, and the label plus the toggle are the only protections. If broadcasting turns out to be unpopular, the toggle's default is the first thing to revisit.
- **A large list against many boards drains slowly by design**, since each board's own rate limit applies. A reader watching the dashboard will see it fill in over hours, and nothing yet tells them that is expected rather than broken.
- **`submit()` is now called from two places with different callers' assumptions.** The queue relies on its refusals being typed well enough to map onto outcomes; a change to how it signals refusal will land here silently.
