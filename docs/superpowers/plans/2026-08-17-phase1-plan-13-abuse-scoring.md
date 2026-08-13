# Abuse Scoring & Escalating Penalties Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repeated abuse cost the abuser something. A durable per-user score, fed by the three signals design §6.4 names, driving a timeout that doubles and then decays.

**Architecture:** A pure `penaltyFor(strikes)` function decides the timeout — the rule worth exhaustive testing is the one with no database behind it, like `can()` and `isLegalTransition()` before it. `AbuseRecord` is the durable state; the check runs on the submit path only, because design §6.4 is explicit that a timeout must not cost someone the ability to read. Decay is a background job, not a read-time computation, so "am I timed out?" stays one indexed lookup.

**Tech Stack:** NestJS 10, Prisma 5.20, Postgres, BullMQ (all existing; no new dependencies).

## Global Constraints

- **No permanent lockouts** (design §6.4). The timeout is capped; a determined abuser waits it out. A lockout that never lifts is a denial-of-service someone else can trigger on your behalf.
- **A timeout blocks submission only.** Viewing and upvoting continue — losing a board you paid for is a punishment out of proportion to a blocked word.
- **The score is durable.** Redis is a mirror, never the record: a flush must not clear everyone's strikes.
- **Strikes are idempotent per event.** One moderation block is one strike, however many times its transaction is retried.
- **Generic errors to the caller, specific in the log** (design §9). A timeout response says when it lifts and nothing about why it was earned — explaining the rule invites gaming it.

## Scope

**In scope:** the `AbuseRecord` model, the pure penalty curve, the three strike sources design §6.4 names, timeout enforcement on submit, decay on good behaviour, and the SPA's rendering of a timed-out state.

**Out of scope — deliberately deferred, with the reason:**

- **The Redis mirror** (design §6.4) → the durable read is a single indexed lookup on a table with one row per abusing user, on a path already doing a rate-limit round trip and a moderation pass. A cache in front of it is machinery without a measured problem, and a mirror that can disagree with the record is a bug waiting to happen.
- **The coarse per-IP token bucket** (design §6.2) → belongs with the edge/WAF work; it protects against floods from unauthenticated sources, which is a different problem from punishing a known user's repeated abuse.
- **Upvote-based abuse** (design §6.4's "unless the abuse is upvote-based") → needs a velocity signal on upvotes, which nothing collects. The carve-out is written into the enforcement so it can be turned on without redesigning it.
- **Creator-visible abuse state** → a moderator seeing "this user has three strikes" is a review-queue feature, and the queue's shape is settled enough that adding a column is cheap later. Nothing in §6.4 asks for it.

## Decisions this plan settles

**Strikes are counted; the penalty is derived.** `AbuseRecord` stores `strikeCount` and `timeoutUntil`, and `penaltyFor(n)` maps count to duration — `1h, 2h, 4h, 8h, …` capped at 7 days. Storing a computed duration would freeze the curve at the moment it was written; storing the count lets the curve change without a migration.

**Decay removes strikes, not time.** Design §6.4 says the score "decays with good behaviour". A user with no new strike for `DECAY_AFTER_HOURS` loses one strike, then another, until the record is gone. Decaying the *timeout* instead would let someone sit out a penalty and return at full severity.

**A refunded duplicate is not free.** The rate limit is refunded on a de-duplicated resubmit — correct, since design §5 wants resubmission to be cheap — but the submission still spent a moderation pass and a catalogue call before reaching the de-dupe check. Repeated refunds from one user are therefore counted, and enough of them in an hour is a strike. This closes the hole Plan 11's review named: replaying a known duplicate was unlimited and free.

**The timeout is checked before the rate limiter, not after.** A timed-out user's request should cost the least possible work. Checking after would mean a blocked user still consumes their hourly quota and a Redis round trip.

**`ModerationResult` still is not persisted.** Plan 09 deferred it for lack of a `FLAG` verdict, and that has not changed. A `BLOCK` now produces a *strike*, which is the durable record §6.4 actually asks for.

---

## Task 1: The penalty curve

**Files:**

- Create: `apps/api/src/abuse/penalty.ts`
- Test: `apps/api/test/penalty.e2e-spec.ts`

**Interfaces:**

- `penaltyFor(strikeCount: number): number` — timeout in milliseconds, `0` when none.
- `MAX_PENALTY_MS`, `DECAY_AFTER_MS`.

Pure. No Prisma, no Redis, no clock.

- [ ] **Step 1: Write the failing test**

```ts
it('costs nothing for a first strike', () => {
  // One blocked word is a mistake, not a campaign. The record exists so the *next* one counts.
  expect(penaltyFor(1)).toBe(0);
});

it('starts at an hour and doubles', () => {
  expect(penaltyFor(2)).toBe(HOUR);
  expect(penaltyFor(3)).toBe(2 * HOUR);
  expect(penaltyFor(4)).toBe(4 * HOUR);
});

it('caps rather than growing forever', () => {
  // Design §6.4: no permanent lockouts, because a lockout is a denial-of-service someone else
  // can trigger on your behalf.
  expect(penaltyFor(50)).toBe(MAX_PENALTY_MS);
  expect(penaltyFor(500)).toBe(MAX_PENALTY_MS);
});

it('never returns a negative or fractional duration', () => {
  for (let n = 0; n <= 40; n += 1) {
    expect(penaltyFor(n)).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(penaltyFor(n))).toBe(true);
  }
});

it('is monotonic', () => {
  for (let n = 1; n < 40; n += 1) expect(penaltyFor(n + 1)).toBeGreaterThanOrEqual(penaltyFor(n));
});

it('treats a zero or negative count as no penalty', () => {
  expect(penaltyFor(0)).toBe(0);
  expect(penaltyFor(-1)).toBe(0);
});
```

- [ ] **Step 2: Run, watch fail, implement, commit**

---

## Task 2: The AbuseRecord model

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260817000000_abuse_record/migration.sql`

```prisma
enum StrikeReason {
  RATE_LIMIT
  MODERATION_BLOCK
  UPHELD_FLAG
  DUPLICATE_FLOOD
}

model AbuseRecord {
  id             String        @id @default(uuid()) @db.Uuid
  userId         String        @unique @db.Uuid
  strikeCount    Int           @default(0)
  // Null when not currently timed out. Always in the past once it lifts; never cleared, so the
  // history stays readable.
  timeoutUntil   DateTime?
  lastStrikeAt   DateTime?
  // Why the most recent strike was earned. For operators reading the table, not for the user.
  lastReason     StrikeReason?
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  // The decay job walks the oldest strike first.
  @@index([lastStrikeAt])
  @@index([timeoutUntil])
}
```

- [ ] **Steps: add the model, hand-write the migration, `migrate deploy`, `migrate reset --force`, commit**

A check constraint the schema cannot express:

```sql
-- A negative strike count would invert the penalty curve.
ALTER TABLE "AbuseRecord" ADD CONSTRAINT "AbuseRecord_strikes_non_negative"
  CHECK ("strikeCount" >= 0);
```

---

## Task 3: The abuse service

**Files:**

- Create: `apps/api/src/abuse/abuse.service.ts`, `apps/api/src/abuse/abuse.module.ts`
- Test: `apps/api/test/abuse.int-spec.ts`

**Interfaces:**

- `AbuseService.strike(userId, reason): Promise<void>`
- `AbuseService.timeoutFor(userId): Promise<Date | null>` — null when free to submit.
- `AbuseService.decayOnce(): Promise<number>`

- [ ] **Step 1: Write the failing test**

```ts
it('records a first strike without timing anyone out', async () => {
  await abuse.strike(userId, 'MODERATION_BLOCK');
  expect(await abuse.timeoutFor(userId)).toBeNull();
  const record = await prisma.abuseRecord.findUniqueOrThrow({ where: { userId } });
  expect(record).toMatchObject({ strikeCount: 1, lastReason: 'MODERATION_BLOCK' });
});

it('times a user out on the second strike', async () => {
  await abuse.strike(userId, 'MODERATION_BLOCK');
  await abuse.strike(userId, 'MODERATION_BLOCK');
  const until = await abuse.timeoutFor(userId);
  expect(until!.getTime()).toBeGreaterThan(Date.now());
});

it('extends rather than resets an active timeout', async () => {
  // A strike during a timeout must not shorten it, which is what a naive `now + penalty` does
  // when the new penalty is smaller than the remaining time.
  await strikeTimes(userId, 5);
  const long = await abuse.timeoutFor(userId);
  await prisma.abuseRecord.update({ where: { userId }, data: { strikeCount: 1 } });
  await abuse.strike(userId, 'RATE_LIMIT');
  expect((await abuse.timeoutFor(userId))!.getTime()).toBeGreaterThanOrEqual(long!.getTime());
});

it('reports no timeout once it has lapsed', async () => {
  await strikeTimes(userId, 2);
  await prisma.abuseRecord.update({
    where: { userId },
    data: { timeoutUntil: new Date(Date.now() - 1000) },
  });
  expect(await abuse.timeoutFor(userId)).toBeNull();
});

it('never times out for longer than the cap', async () => {
  await strikeTimes(userId, 40);
  const until = await abuse.timeoutFor(userId);
  expect(until!.getTime() - Date.now()).toBeLessThanOrEqual(MAX_PENALTY_MS + 5000);
});

it('is concurrency-safe: two simultaneous strikes both count', async () => {
  await Promise.all([abuse.strike(userId, 'RATE_LIMIT'), abuse.strike(userId, 'RATE_LIMIT')]);
  expect((await prisma.abuseRecord.findUniqueOrThrow({ where: { userId } })).strikeCount).toBe(2);
});

it('answers null for a user with no record, without creating one', async () => {
  expect(await abuse.timeoutFor(otherUserId)).toBeNull();
  expect(await prisma.abuseRecord.count()).toBe(0);
});
```

Decay:

```ts
it('removes one strike after a quiet period', async () => {
  await strikeTimes(userId, 3);
  await makeQuiet(userId);
  await abuse.decayOnce();
  expect((await prisma.abuseRecord.findUniqueOrThrow({ where: { userId } })).strikeCount).toBe(2);
});

it('leaves a recently struck user alone', async () => {
  await strikeTimes(userId, 3);
  await abuse.decayOnce();
  expect((await prisma.abuseRecord.findUniqueOrThrow({ where: { userId } })).strikeCount).toBe(3);
});

it('deletes the record when the last strike decays', async () => {
  // Otherwise the table accumulates a row per user who ever slipped once.
  await abuse.strike(userId, 'RATE_LIMIT');
  await makeQuiet(userId);
  await abuse.decayOnce();
  expect(await prisma.abuseRecord.count({ where: { userId } })).toBe(0);
});

it('does not decay a user whose timeout is still running', async () => {
  // Sitting out a penalty must not also earn forgiveness.
  await strikeTimes(userId, 3);
  await makeQuiet(userId);
  await prisma.abuseRecord.update({
    where: { userId },
    data: { timeoutUntil: new Date(Date.now() + HOUR) },
  });
  await abuse.decayOnce();
  expect((await prisma.abuseRecord.findUniqueOrThrow({ where: { userId } })).strikeCount).toBe(3);
});

it('stops at the batch size', async () => { ... });
```

- [ ] **Step 2: Run, watch fail, implement**

`strike` uses an upsert with an atomic `increment`, then computes the new timeout from the *returned*
count — so two concurrent strikes cannot both read the same starting value.

- [ ] **Step 3: Run and commit**

---

## Task 4: Feeding the score, and enforcing it

**Files:**

- Modify: `apps/api/src/recommendations/recommendations.service.ts`, `apps/api/src/moderation/review-queue.service.ts`, `apps/api/src/jobs/jobs.module.ts`
- Create: `apps/api/src/jobs/abuse-decay.job.ts`
- Test: `apps/api/test/abuse-enforcement.int-spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('blocks a submission from a timed-out user with 403 and when it lifts', async () => {
  await timeOut(patronUserId);
  const res = await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'Nope' }).expect(403);
  expect(res.body.retryAt).toBeDefined();
  // And says nothing about why: explaining the rule invites gaming it.
  expect(JSON.stringify(res.body)).not.toMatch(/strike|moderation|abuse/i);
});

it('still lets a timed-out user read and upvote', async () => {
  // Design §6.4: a timeout blocks submission only. Losing a board you paid for is out of
  // proportion to a blocked word.
  await timeOut(patronUserId);
  await board(patron).expect(200);
  await upvote(patron, existingId).expect(200);
});

it('costs a timed-out user no rate-limit quota', async () => {
  await timeOut(patronUserId);
  await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'Nope' }).expect(403);
  await clearTimeout(patronUserId);
  await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'Fine' }).expect(201);
});

it('strikes on a moderation block', async () => {
  await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'this is shit' }).expect(400);
  expect(await strikesFor(patronUserId)).toBe(1);
});

it('strikes on a rate-limit hit', async () => {
  await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'One' }).expect(201);
  await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'Two' }).expect(429);
  expect(await strikesFor(patronUserId)).toBe(1);
});

it('strikes on a flag a moderator upholds', async () => {
  // "Upheld" is RESOLVED: a moderator agreed with the report. DISMISSED must not strike, or
  // reporting becomes a weapon against the person reported.
  await upholdFlagOn(entryId, submitterUserId);
  expect(await strikesFor(submitterUserId)).toBe(1);
});

it('does not strike on a dismissed flag', async () => {
  await dismissFlagOn(entryId, submitterUserId);
  expect(await strikesFor(submitterUserId)).toBe(0);
});

it('strikes after repeated duplicate resubmissions', async () => {
  // Plan 11's review: a refunded duplicate still spent a moderation pass and a catalogue call,
  // so replaying one was unlimited and free.
  for (let i = 0; i < DUPLICATE_STRIKE_THRESHOLD; i += 1) {
    await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'Same' });
  }
  expect(await strikesFor(patronUserId)).toBeGreaterThanOrEqual(1);
});

it('does not strike a single duplicate', async () => {
  await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'Same' }).expect(201);
  await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'Same' }).expect(200);
  expect(await strikesFor(patronUserId)).toBe(0);
});

it('never lets a strike failure break the request it was reacting to', async () => {
  // The score is a side effect. A submission must not 500 because the abuse table was busy.
  abuseService.strike = async () => { throw new Error('down'); };
  await submit(patron, { type: 'EXTERNAL_LINK', customTitle: 'this is shit' }).expect(400);
});
```

- [ ] **Step 2: Run, watch fail, implement**

The moderation block, rate-limit and duplicate strikes go in `RecommendationsService.submit`; the
upheld-flag strike goes in `ReviewQueueService.resolveFlag`, striking the *submitter*, never the
reporter. Every strike call is wrapped so it cannot fail the request it observes.

- [ ] **Step 3: Wire `AbuseDecayJob` into the existing tick, run and commit**

---

## Task 5: The SPA

**Files:**

- Modify: `apps/web/src/components/SubmitForm.tsx`, `apps/web/src/api/client.ts`
- Test: `apps/web/src/components/SubmitForm.test.tsx` (extend)

- [ ] **Step 1: Write the failing test**

Asserts: a 403 carrying `retryAt` renders "You cannot suggest anything until <time>" rather than the
generic refusal; a 403 without `retryAt` still renders the generic one; the message says nothing
about strikes; the form stays mounted so the user is not left wondering where it went.

`ApiError` gains an optional `retryAt`, parsed from the body — the one place the server's body is
read, because "when" is information the user needs to act on and the status alone cannot carry it.

- [ ] **Step 2: Implement, run, commit**

---

## Task 6: End-to-end and verification

**Files:**

- Modify: `e2e/tests/support.ts`, `e2e/tests/journey.spec.ts`, `README.md`

- [ ] **Step 1: Add the journey**

A timed-out patron sees the board and can upvote, but the submit form refuses with a time.

- [ ] **Step 2: Full verification**

```bash
pnpm -r typecheck && pnpm -r test && pnpm format:check
docker-compose -f docker-compose.e2e.yml up -d --build && pnpm --filter e2e e2e
```

- [ ] **Step 3: Document the curve and the strike sources in the README, commit**

---

## Self-Review

**Spec coverage (design §6.4, and §6.5's "BLOCK → rejected + abuse strike"):**

- Durable per-user abuse score → Tasks 2, 3. ✅
- Strikes from repeated rate-limit hits, moderation `BLOCK`s, and mod-upheld flags → Task 4, all three. ✅
- Timeout grows `1h→2h→4h→…`, capped → Task 1. ✅
- Decays with good behaviour → Task 3. ✅
- No permanent lockouts → Task 1's cap, tested. ✅
- "During a timeout, submission is blocked; viewing/upvoting remain" → Task 4, tested both ways. ✅
- "unless the abuse is upvote-based" → **not built**; nothing measures upvote velocity. The carve-out is where it would go.
- `AbuseRecord` + **Redis mirror** → Postgres only; the mirror is **deferred** with its reason in Scope.

## Found in review (fixed)

1. **Critical — upheld flags struck per *report*, not per *offence*, making the strike count
   attacker-controlled.** Flags are one-per-reporter, and flagging needs only `VIEW` on a public
   board with no rate limit. Ten throwaway accounts reporting one entry, resolved one by one in
   good faith, landed ten strikes — the cap — locking a patron out of **every board they pay
   for** for seven days. The cap bounds the duration; nothing bounded the count, so §6.4's whole
   defence against denial-of-service-by-lockout was routed around. Now at most one `UPHELD_FLAG`
   strike per entry.
2. **Important — every 429 was a strike, against a 1/hour cap.** §6.4 says *repeated* hits. A
   patron with a second idea ten minutes later got a strike; three impatient clicks timed them
   out of every board. Now thresholded.
3. **Important — `strike` was not atomic.** The increment and the timeout write were separate
   statements, so two concurrent strikes computed from the same stale snapshot and the later
   commit won: hitting twice at once bought a *shorter* penalty than hitting twice in sequence.
   Now one transaction with `SELECT … FOR UPDATE`. Note the test does not reliably reproduce the
   interleaving — the correctness comes from the lock, not from the test.
4. **Important — the duplicate counter struck on every request past the threshold, and its
   window was global.** Six duplicates earned two strikes and an hour's lockout, and a patron of
   six creators suggesting one popular title to each — six 200s, exactly what design §5 asks for
   — tripped it. Now strikes once, keyed per creator.
5. **Important — two tests could not fail.** "Costs a timed-out user no rate-limit quota" ran
   against a limit of 50, so it passed with the ordering reversed; it now runs against one
   remaining allowance. "Strikes after repeated duplicates" asserted `>= 1`, which the bug in (4)
   also satisfied; it now asserts exactly one.
6. **Minor, also fixed:** a `BLOCK` on a *flag note* did not strike, leaving a free oracle for
   binary-searching the blocklist before crafting a submission that would cost something; decay
   sat last in an unguarded job chain, so any upstream failure skipped the only mechanism that
   ever reduces a strike count — it now runs first, and each job is isolated; and `reset`/
   `exhaust` were public methods on an app-wide service, one careless controller from letting
   anyone lock anyone out.

**Known risks:**

1. **Strikes are per user, not per creator.** Someone abusing one board is blocked from submitting to every board they patronise. That is what "per-user abuse score" in §6.4 means, and it is the right default for a shared moderation signal — but a creator with an unusually strict wordlist can effectively time a patron out of somebody else's board.
2. **A moderator can manufacture strikes** by upholding flags on one user repeatedly. The audit log records every resolution and who made it, so the behaviour is visible, but nothing automatically detects it.
3. **Decay is a fixed interval per strike**, so a user with twenty strikes takes twenty quiet periods to clear. Deliberate — that is what escalation means — but it means the practical maximum is much longer than the timeout cap suggests, and nothing surfaces "you are still carrying strikes" to the user.
4. **The duplicate-flood counter lives in Redis** and a flush resets it. Unlike the score itself, this one is not durable; it is a velocity signal rather than a record, and losing it costs at most one missed strike.
