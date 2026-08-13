# Creator Notes & Timelines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a creator somewhere to write down what they think about an entry and when they plan to get to it — the last piece of design §7's dashboard that has nowhere to live.

**Architecture:** `CreatorNote` hangs off a recommendation with a `kind` that decides where it renders: `NOTE` is commentary in the review queue, `TIMELINE` is a scheduling entry the patron board shows. That split is the whole design — one model, two audiences — so the visibility rule lives in one place and is tested from both sides.

**Tech Stack:** NestJS 10, Prisma 5.20, Postgres, React 18 (all existing; no new dependencies).

## Global Constraints

- **Only staff write notes** (`MODERATE`). A note is the creator's voice on their own board.
- **`TIMELINE` notes are public; `NOTE` notes are staff-only.** That is the entire point of the kind, so the read model must never conflate them.
- **Notes are moderated like any other text.** A creator's own words still land on a public board, and design §6.5 puts every user string through the pipeline.
- **Every note records its author**, and deleting the author's account must not erase the note's existence — the same rule `ModerationAction` follows.
- **No `dangerouslySetInnerHTML`.** A note is free text.
- **Bounded:** 2000 characters, matching a description, and capped per entry.

## Scope

**In scope:** the `CreatorNote` model, staff CRUD, `TIMELINE` notes on the patron board, `NOTE` notes in the review queue, and the SPA for both.

**Out of scope — deliberately deferred, with the reason:**

- **A rich timeline view** (design §7's "rendered as a lightweight timeline") → the data lands here, ordered and dated. A calendar or Gantt rendering is a design problem, and the board's card is the honest first surface.
- **Notes on anything but a recommendation** → design §3 defines `CreatorNote` as per entry. A board-level changelog is a different model.
- **Editing history** → `ModerationAction` is per-recommendation and entry-scoped; a note's own audit trail has nowhere to go, and the same gap is already recorded against staff changes.
- **Patron replies** → design §7 reserves discussion threads for Phase 2 explicitly.

## Decisions this plan settles

**One model, two audiences, one visibility rule.** `kind` decides who sees a note, and that decision is expressed once as a `where` clause the board and the queue both derive from. Two models would drift; a boolean called `isPublic` would lose the meaning that makes the queue's copy useful.

**A `TIMELINE` note carries an optional date, a `NOTE` never does.** "We'll cover this in March" is the whole reason the kind exists. The date is nullable because "soon, no promises" is also a legitimate thing to say, and forcing a date would make creators invent one.

**Notes are ordered oldest-first.** A timeline read backwards is not a timeline, and commentary reads as a conversation with itself. This is the opposite of the review queue's flag ordering, deliberately.

**Deleting a note is a hard delete.** Unlike a recommendation, a note has no upvotes, no de-duplication key and no audience relying on its permanence — and a creator who writes something they regret on their own board should be able to remove it, not merely hide it.

---

## Task 1: The model

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260819000000_creator_note/migration.sql`

```prisma
enum NoteKind {
  NOTE
  TIMELINE
}

model CreatorNote {
  id               String   @id @default(uuid()) @db.Uuid
  recommendationId String   @db.Uuid
  authorUserId     String   @db.Uuid
  kind             NoteKind
  body             String
  // Only meaningful on a TIMELINE note: "we'll cover this in March". Nullable because "soon,
  // no promises" is a legitimate thing to say, and requiring a date invents one.
  plannedFor       DateTime?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  recommendation Recommendation @relation(fields: [recommendationId], references: [id], onDelete: Cascade)
  // Restrict, like ModerationAction: deleting a moderator's account must not erase what they
  // wrote on someone else's board.
  author         User           @relation("NoteAuthor", fields: [authorUserId], references: [id], onDelete: Restrict)

  @@index([recommendationId, createdAt])
  @@index([authorUserId])
}
```

A check constraint the schema cannot express:

```sql
-- A planned date on editor commentary has no meaning and nothing renders it.
ALTER TABLE "CreatorNote" ADD CONSTRAINT "CreatorNote_planned_only_on_timeline"
  CHECK ("kind" = 'TIMELINE' OR "plannedFor" IS NULL);
```

- [ ] **Steps: add the model, hand-write the migration, `migrate deploy`, `migrate reset --force`, commit**

---

## Task 2: Writing notes

**Files:**

- Create: `apps/api/src/notes/notes.service.ts`, `apps/api/src/notes/notes.controller.ts`, `apps/api/src/notes/notes.module.ts`, `apps/api/src/notes/dto/write-note.dto.ts`
- Test: `apps/api/test/notes.int-spec.ts`

**Interfaces:**

- `POST /creators/:slug/recommendations/:id/notes` → the created note, `MODERATE`
- `PATCH /creators/:slug/notes/:noteId` → the updated note, `MODERATE`
- `DELETE /creators/:slug/notes/:noteId` → 204, `MODERATE`

- [ ] **Step 1: Write the failing test**

```ts
it('records a note against the entry with its author', async () => {
  const res = await post(staff, `/creators/${slug}/recommendations/${recId}/notes`, {
    kind: 'NOTE', body: 'Worth doing after the finale.',
  }).expect(201);
  expect(res.body).toMatchObject({ kind: 'NOTE', body: 'Worth doing after the finale.' });
  expect(res.body.author.id).toBe(staffUserId);
});

it('accepts a planned date on a timeline note', async () => {
  const res = await post(staff, `.../notes`, {
    kind: 'TIMELINE', body: 'March stream', plannedFor: '2026-03-01T00:00:00.000Z',
  }).expect(201);
  expect(res.body.plannedFor).toBe('2026-03-01T00:00:00.000Z');
});

it('refuses a planned date on editor commentary', async () => {
  // Nothing renders it, and the check constraint agrees.
  await post(staff, `.../notes`, { kind: 'NOTE', body: 'x', plannedFor: '2026-03-01' })
    .expect(400);
});

it('refuses a patron', async () => {
  await post(patron, `.../notes`, { kind: 'NOTE', body: 'mine' }).expect(403);
});

it('refuses an entry on another creator board', async () => {
  await post(staff, `/creators/${slug}/recommendations/${foreignRecId}/notes`, {...}).expect(404);
});

it('moderates the body', async () => {
  // A creator's own words still land on a public board when the kind is TIMELINE.
  await post(staff, `.../notes`, { kind: 'TIMELINE', body: 'this is shit' }).expect(400);
});

it('caps how many notes an entry can carry', async () => {
  for (let i = 0; i < MAX_NOTES_PER_ENTRY; i += 1) await post(staff, ..., {...}).expect(201);
  await post(staff, ..., {...}).expect(409);
});

it('edits a note', async () => { ... });

it('moderates an edited body', async () => { ... });

it('refuses to edit or delete a note on another creator board', async () => {
  // A note id alone says nothing about which board it belongs to.
  await patch(staff, `/creators/${slug}/notes/${foreignNoteId}`, {...}).expect(404);
  await del(staff, `/creators/${slug}/notes/${foreignNoteId}`).expect(404);
});

it('deletes a note', async () => { ... });
```

- [ ] **Step 2: Run, watch fail, implement, commit**

---

## Task 3: Reading them back

**Files:**

- Modify: `apps/api/src/recommendations/recommendations.service.ts`, `apps/api/src/moderation/review-queue.service.ts`
- Test: `apps/api/test/notes.int-spec.ts` (extend)

**Interfaces:**

- Board entries gain `notes: Array<{ id, kind, body, plannedFor, author, createdAt }>` — `TIMELINE` only.
- Review-queue items gain `notes` — every kind.

- [ ] **Step 1: Write the failing test**

```ts
it('shows timeline notes on the patron board', async () => {
  const res = await board(patron).expect(200);
  expect(entry(res, recId).notes).toEqual([expect.objectContaining({ kind: 'TIMELINE' })]);
});

it('never shows editor commentary to a patron', async () => {
  // The whole point of the kind. A NOTE leaking onto the board is the failure this guards.
  const res = await board(patron).expect(200);
  expect(JSON.stringify(res.body)).not.toContain(privateNoteBody);
});

it('never shows editor commentary to an anonymous visitor', async () => { ... });

it('shows both kinds to staff in the review queue', async () => {
  const res = await queue(staff).expect(200);
  expect(res.body.items[0].notes.map((n) => n.kind).sort()).toEqual(['NOTE', 'TIMELINE']);
});

it('orders notes oldest first', async () => {
  // A timeline read backwards is not a timeline.
  const res = await queue(staff).expect(200);
  expect(res.body.items[0].notes.map((n) => n.body)).toEqual(['first', 'second', 'third']);
});

it('leaves an entry with no notes an empty array', async () => { ... });
```

The "never shows commentary" pair is the assertion that matters — it is asserted on the whole
serialised response, not on a field, so a note leaking through any other path still fails it.

- [ ] **Step 2: Run, watch fail, implement, commit**

---

## Task 4: The SPA

**Files:**

- Create: `apps/web/src/components/NoteList.tsx`, `apps/web/src/components/NoteEditor.tsx`
- Modify: `apps/web/src/components/RecommendationCard.tsx`, `apps/web/src/routes/ReviewQueue.tsx`, `apps/web/src/api/types.ts`, `apps/web/src/test-support.tsx`
- Test: `apps/web/src/components/NoteList.test.tsx`, `apps/web/src/components/NoteEditor.test.tsx`

- [ ] **Step 1: Write the failing tests**

`NoteList`: renders nothing when there are none; renders a timeline note with its planned date and
a commentary note without one; shows the author; renders a body containing markup as text; labels
the two kinds distinguishably so a moderator can see at a glance which is public.

`NoteEditor` (queue only): posts a note with its kind; the date field appears only for `TIMELINE`;
an empty body is blocked client-side without a request; a 400 shows the rejection; a created note
appears in the list without a refetch; deleting removes it.

- [ ] **Step 2: Implement, run, commit**

---

## Task 5: End-to-end and verification

**Files:**

- Modify: `e2e/tests/journey.spec.ts`, `README.md`

- [ ] **Step 1: Add the journey**

A moderator writes one commentary note and one timeline note on an entry; the patron board shows
the timeline note and does not contain the commentary text anywhere.

- [ ] **Step 2: Full verification**

```bash
pnpm -r typecheck && pnpm -r test && pnpm format:check
docker-compose -f docker-compose.e2e.yml up -d --build && pnpm --filter e2e e2e
```

- [ ] **Step 3: Document notes in the README, commit**

---

## Self-Review

**Spec coverage (design §3 `CreatorNote`, §7 "Notes & timelines", §8 API surface):**

- `CreatorNote` per entry with `recommendationId`, `authorUserId`, `body`, `kind ∈ {NOTE, TIMELINE}` → Task 1. ✅
- `NOTE` as editor commentary, `TIMELINE` as scheduling → Tasks 1–3, with the visibility split tested from both sides. ✅
- `CreatorNote` CRUD in the API surface → Task 2. ✅
- "rendered as a lightweight timeline" → **partially**: notes render in order with their dates on the card. A dedicated timeline visualisation is deferred with its reason.

**Known risks:**

1. **A `TIMELINE` note is public the moment it is written.** There is no draft state, so a creator thinking out loud in the wrong kind has published it. The kind picker defaults to `NOTE` for that reason, but nothing stops a mis-click — and the fix is a delete, which is immediate but not retroactive.
2. **Notes are not audited.** Editing one leaves no trace of what it said before, unlike a redaction. `ModerationAction` is entry-scoped and would need a note-scoped equivalent; the same gap is already recorded against staff changes.
3. **`plannedFor` is a date with no timezone semantics.** It is stored as a timestamp and rendered in the reader's locale, so "March" means different things at the edges. Fine for "roughly when", wrong if anyone ever builds scheduling on it.
4. **The cap is per entry, not per creator.** A moderator can still write two hundred notes across twenty entries; nothing here is a rate limit, and notes are staff-only so the abuse surface is a staff member.
