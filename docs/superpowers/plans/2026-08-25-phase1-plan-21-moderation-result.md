# Moderation Results & Creator Blocklist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a record of what the moderation pipeline decided and why, and give creators the per-creator blocklist design §6.5 promised — which is also what makes the `FLAG` verdict reachable at all.

**Architecture:** `ModerationService.review` becomes `review(subject, parts)`: it cannot be called without saying what is being reviewed, so a call site cannot forget to record the verdict. Non-`PASS` verdicts are written to `ModerationResult`. A `CreatorBlockword` table feeds a second wordlist stage scoped to one board, whose entries choose between `BLOCK` (reject outright) and `FLAG` (let it through, put it in front of a moderator).

**Tech Stack:** NestJS 10, Prisma 5.20, Postgres 16, `obscenity`, Jest + Testcontainers.

## Global Constraints

- Free tooling only. This is why design §6.5's stage (b) — a hosted ML moderation API — is still not built: every credible one is paid.
- Hand-written migrations under `apps/api/prisma/migrations/`.
- Every creator-scoped query filters on `creatorId`.
- Policy-shaped controls are `ADMINISTER`, not `MODERATE` — settled in Plan 14, where a mod could otherwise change what the board allows.

## Decisions this plan settles

1. **`review` takes a subject.** Five call sites review user text today and none of them records anything. Adding a separate `record()` would make "forgot to call it" a permanent defect class; folding it into the one method that already exists means the type system asks the question.
2. **Only `FLAG` and `BLOCK` are stored. `PASS` is the absence of a row.** Every submission, note, rename and report passes through this pipeline, and the overwhelming majority pass. A row each would be the largest table in the database, holding no information anyone will read. The count of things reviewed is not a number this product needs.
3. **The offending text is not stored.** A `BLOCK` on a slur would otherwise mean the database keeps that slur for ever, on a row nobody reads, on a board that never accepted it — and design §6.6 gives moderators redaction precisely so text like that can be removed. Categories and the verdict are what a moderator or an appeal needs. Where the content *was* created (a `FLAG`), it is readable through `subjectId`.
4. **A blocked submission still gets a row, with a null `subjectId`.** The submission is rejected and never created, so there is nothing to point at — but that is exactly the case where the record matters, because it is the evidence behind an abuse strike.
5. **The creator blocklist matches plainly — normalised substring, no leetspeak folding.** The `obscenity` stage already handles evasion for the global list. A creator adding "spoiler" or a specific handle wants that term matched, and a matcher built per creator per request is a cost paid on every submission for a list of a dozen words.
6. **`FLAG` does not create a `Flag` row.** Reusing the community-report table would put a report with no reporter into a queue whose whole design assumes one, and `Flag`'s unique index is `(recommendationId, flaggedByUserId)`. The queue reads the verdict directly instead.

## Scope

**In:** `ModerationResult` model + recording at all five call sites; `CreatorBlockword` model + `ADMINISTER` CRUD; the creator stage in the pipeline; `FLAG` surfaced and prioritised in the review queue.

**Out, with reasons:**
- *The ML stage (design §6.5b).* Paid, and the free-only constraint stands. The `source` column and the `Moderator` interface are the seam it plugs into; nothing else changes when it arrives.
- *Auto-hide on FLAG* ("optional auto-hide" in §6.5). Hiding a patron's entry on a substring match, before a human looks, is a heavier default than a board should get without asking for it. The queue placement is the same signal without the collateral.
- *Appeals.* There is no route for a user to contest a `BLOCK`, and building one means deciding who reviews it and on what timescale.
- *Regex or wildcard blocklist entries.* A creator-supplied regex is an ReDoS waiting to run on every submission.
- *Retention/pruning of `ModerationResult`.* Same open question as notifications; recorded as a risk rather than half-answered.

## File Structure

- `apps/api/prisma/schema.prisma` — `ModerationResult`, `CreatorBlockword`, `BlockwordAction`, `ModerationSubjectType`.
- `apps/api/prisma/migrations/20260825000000_moderation_result/migration.sql`
- `apps/api/src/moderation/moderation.service.ts` — `review(subject, parts)` + recording.
- `apps/api/src/moderation/moderation.types.ts` — `ModerationSubject`.
- `apps/api/src/moderation/creator-blocklist.moderator.ts` — the per-creator stage.
- `apps/api/src/creators/blocklist.controller.ts` + dto — `ADMINISTER` CRUD.
- `apps/api/src/moderation/review-queue.service.ts` — expose and prioritise the verdict.
- Call sites: `recommendations.service.ts`, `notes.service.ts`, `themes.controller.ts`, `flags.service.ts`, `review-queue.service.ts`.
- `apps/api/test/moderation-result.int-spec.ts`, `apps/api/test/creator-blocklist.int-spec.ts`

---

### Task 1: Record what the pipeline decided

**Interfaces:**
- Produces:
  ```ts
  type ModerationSubjectType = 'RECOMMENDATION' | 'NOTE' | 'THEME' | 'FLAG_NOTE';
  interface ModerationSubject {
    creatorId: string;
    userId: string;
    type: ModerationSubjectType;
    /** Null when the content was rejected and therefore never created. */
    id?: string | null;
  }
  review(subject: ModerationSubject, parts: Array<string | undefined | null>): Promise<ModerationResultData>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it('records a block, with no subject id because nothing was created', async () => {
  await expect(submit({ customTitle: 'this is shit' })).rejects.toThrow();
  const [row] = await prisma.moderationResult.findMany();
  expect(row).toMatchObject({
    verdict: 'BLOCK', source: 'WORDLIST', subjectType: 'RECOMMENDATION',
    subjectId: null, userId: patron.id, creatorId,
  });
});

it('records nothing for text that passes', async () => {
  await submit({ customTitle: 'A perfectly ordinary film' });
  expect(await prisma.moderationResult.count()).toBe(0);
});

it('keeps the offending text out of the record', async () => {
  await expect(submit({ customTitle: 'this is shit' })).rejects.toThrow();
  const rows = await prisma.$queryRaw<Array<{ t: string }>>`
    SELECT row_to_json("ModerationResult")::text AS t FROM "ModerationResult"`;
  expect(rows[0].t).not.toMatch(/shit/i);
});
```

- [ ] **Step 2: Run and verify they fail** — `prisma.moderationResult` is undefined.

- [ ] **Step 3: Schema**

```prisma
enum ModerationSubjectType {
  RECOMMENDATION
  NOTE
  THEME
  FLAG_NOTE
}

model ModerationResult {
  id          String                @id @default(uuid()) @db.Uuid
  creatorId   String                @db.Uuid
  userId      String                @db.Uuid
  subjectType ModerationSubjectType
  // Null when the content was rejected outright: there is nothing to point at, and that is
  // exactly the case where the record matters, because it is the evidence behind a strike.
  subjectId   String?               @db.Uuid
  verdict     String
  categories  String[]
  source      String
  createdAt   DateTime              @default(now())

  creator Creator @relation(fields: [creatorId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([creatorId, createdAt(sort: Desc)])
  @@index([subjectId])
}
```

- [ ] **Step 4: Migration** — table, both FKs `ON DELETE CASCADE`, both indexes.

- [ ] **Step 5: Service**

```ts
async review(subject: ModerationSubject, parts: Array<string | undefined | null>) {
  let worst: ModerationResultData = { verdict: 'PASS', categories: [], source: 'WORDLIST' };
  for (const part of parts) {
    if (!part) continue;
    for (const moderator of this.moderators) {
      const result = await moderator.review(part, subject.creatorId);
      if (SEVERITY[result.verdict] > SEVERITY[worst.verdict]) worst = result;
    }
  }
  // PASS is the absence of a row: every submission, note and rename comes through here and
  // almost all of them pass, so recording those would be the largest table in the database
  // holding nothing anyone reads.
  if (worst.verdict !== 'PASS') {
    await this.prisma.moderationResult.create({
      data: {
        creatorId: subject.creatorId,
        userId: subject.userId,
        subjectType: subject.type,
        subjectId: subject.id ?? null,
        verdict: worst.verdict,
        categories: worst.categories,
        source: worst.source,
      },
    });
  }
  return worst;
}
```

- [ ] **Step 6: Update all five call sites** to pass a subject. `recommendations.service.ts` reviews before the entry exists, so its `id` is null; `notes.service.ts`, `themes.controller.ts` and `flags.service.ts` pass the id of the thing being written about; `review-queue.service.ts`'s redact passes the recommendation id.

- [ ] **Step 7: Run tests, then mutation-check** — dropping the `verdict !== 'PASS'` guard, and dropping `subjectId` from the create, must each fail a test.

- [ ] **Step 8: Commit**

---

### Task 2: The per-creator blocklist

**Interfaces:**
- `Moderator.review(text: string, creatorId: string)` — the interface gains the board, since one of its implementations is per-board.
- `POST|GET|DELETE /creators/:slug/blocklist` — `ADMINISTER`.

- [ ] **Step 1: Write the failing tests**

```ts
it('blocks a word this board added, which passes on another board', async () => {
  await addWord(owner, { pattern: 'Ganondorf', action: 'BLOCK' });
  await expect(submitTo(creatorId, 'The Ganondorf Cut')).rejects.toThrow();
  await expect(submitTo(otherCreatorId, 'The Ganondorf Cut')).resolves.toBeDefined();
});

it('flags rather than blocks when the word says so', async () => {
  await addWord(owner, { pattern: 'spoiler', action: 'FLAG' });
  const created = await submitTo(creatorId, 'Huge spoiler discussion');
  // Let through — and recorded, which is what puts it in front of a moderator.
  expect(created.status).toBe('PENDING');
  const [row] = await prisma.moderationResult.findMany({ where: { subjectId: created.id } });
  expect(row).toMatchObject({ verdict: 'FLAG', source: 'CREATOR' });
});

it('matches without regard to case', async () => {
  await addWord(owner, { pattern: 'GANONDORF', action: 'BLOCK' });
  await expect(submitTo(creatorId, 'the ganondorf cut')).rejects.toThrow();
});

it('refuses a blocklist change from a moderator', async () => {
  await addWord(mod, { pattern: 'anything', action: 'BLOCK' }).expect(403);
});

it('never applies one board list to another board', async () => {
  await addWord(owner, { pattern: 'Ganondorf', action: 'BLOCK' });
  expect(await listWords(otherOwner)).toEqual({ items: [] });
});
```

- [ ] **Step 2: Verify they fail.**

- [ ] **Step 3: Schema + migration**

```prisma
enum BlockwordAction {
  BLOCK
  FLAG
}

model CreatorBlockword {
  id        String          @id @default(uuid()) @db.Uuid
  creatorId String          @db.Uuid
  /** Stored normalised (trimmed, lowercased) — it is matched, not displayed. */
  pattern   String
  action    BlockwordAction @default(BLOCK)
  createdAt DateTime        @default(now())

  creator Creator @relation(fields: [creatorId], references: [id], onDelete: Cascade)

  @@unique([creatorId, pattern])
}
```

- [ ] **Step 4: The moderator**

```ts
@Injectable()
export class CreatorBlocklistModerator implements Moderator {
  constructor(private readonly prisma: PrismaService) {}

  async review(text: string, creatorId: string): Promise<ModerationResultData> {
    const words = await this.prisma.creatorBlockword.findMany({
      where: { creatorId },
      select: { pattern: true, action: true },
    });
    const haystack = text.toLowerCase();
    // Plain substring, deliberately: the obscenity stage already folds leetspeak for the global
    // list, and building a matcher per creator per submission is a cost paid on every request
    // for a list of a dozen words a creator typed themselves.
    const hit = words.find((word) => haystack.includes(word.pattern));
    if (!hit) return { verdict: 'PASS', categories: [], source: 'CREATOR' };
    return { verdict: hit.action, categories: ['CREATOR_BLOCKLIST'], source: 'CREATOR' };
  }
}
```

- [ ] **Step 5: Controller** — `@RequireCapability('ADMINISTER')`, `POST` normalises the pattern and 409s on a duplicate, `DELETE` scoped by `creatorId` as well as id.

- [ ] **Step 6: Run tests, then mutation-check** — dropping `where: { creatorId }` from the moderator's query and from the delete must each fail a test. This is the project's most-repeated defect; the tenancy tests must use a *second board that also has words*, not an empty one.

- [ ] **Step 7: Commit**

---

### Task 3: Put a FLAG in front of a moderator

- [ ] **Step 1: Write the failing tests**

```ts
it('shows the pipeline verdict on the queue item', async () => {
  const created = await submitTo(creatorId, 'Huge spoiler discussion');
  const { items } = await queue.list(creatorId);
  expect(items.find((i) => i.id === created.id)?.moderation).toMatchObject({
    verdict: 'FLAG', categories: ['CREATOR_BLOCKLIST'],
  });
});

it('sorts a flagged entry above an untouched one', async () => {
  const quiet = await submitTo(creatorId, 'An ordinary film');
  const flagged = await submitTo(creatorId, 'Huge spoiler discussion');
  const { items } = await queue.list(creatorId);
  expect(items.findIndex((i) => i.id === flagged.id)).toBeLessThan(
    items.findIndex((i) => i.id === quiet.id),
  );
});

it('ranks a reported entry above a merely flagged one', async () => {
  // A human took the trouble to report; the pipeline only matched a substring.
  ...
});
```

- [ ] **Step 2: Ordering** — extend the existing raw query, which already sorts by open flag count, with a left join onto unresolved `FLAG` results. Keep it one query: sorting after the limit would sort the wrong page, which this file already carries a comment about.

- [ ] **Step 3: Expose `moderation`** on the queue item, selected explicitly.

- [ ] **Step 4: Run everything**, `pnpm format:check`, commit.

---

## Known risks

- **A blocklist query per moderated string.** Every submission now reads `CreatorBlockword` once per part. The list is small and the index is on `creatorId`, but this is on the submission hot path and nothing caches it.
- **Substring matching catches innocent words.** A creator blocking "ass" blocks "assassin". Design §6.5 wanted a creator-controlled list and this is what one behaves like; the `FLAG` action exists so a creator can choose the softer failure, but nothing warns them at the point they add a word.
- **No retention on `ModerationResult`.** Same open question as `Notification`: the table only grows, and deciding what old records are worth keeping is a policy question this plan does not answer.
- **`FLAG` has no expiry.** A flagged entry sits high in the queue until a moderator acts on it; nothing marks a verdict "seen" short of resolving the entry itself.
