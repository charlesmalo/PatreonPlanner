# Fuzzy Board Search & Pre-Submit De-duplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a patron what is already on the board *before* they submit, matching the way people actually type — "sprited away", "totoro", "the matrix 2".

**Architecture:** `pg_trgm` finds candidate ids by trigram similarity in one raw query; those ids then go through the **existing board projection**, which already applies every visibility rule. Similarity ranking and access control stay in separate places on purpose — hand-writing the visibility clause a second time in SQL is how a hidden entry leaks.

**Tech Stack:** Postgres `pg_trgm` (a contrib extension, already available in the `pgvector/pgvector:pg16` image), NestJS 10, Prisma 5.20, React 18. **No new dependency, no key, no vendor.**

## Global Constraints

- **Search obeys the board's visibility rules exactly.** A `REJECTED` entry, a soft-deleted one, and another patron's `PENDING` entry under `hidePendingFromPublic` must be as invisible here as on the board — and by the same code, not a copy of it.
- **This is a read.** It creates nothing, spends no third-party quota, and touches no external service.
- **Bounded:** a capped result count and a minimum query length, so a one-character query cannot ask Postgres to rank the whole table.
- **No `dangerouslySetInnerHTML`.** Results are attacker-authored titles.
- **Generic errors to the caller** (design §9).

## Scope

**In scope:** the `pg_trgm` extension and its index, a similarity search over entry titles and catalogue aliases, an endpoint that returns board entries in the board's own shape, and the SPA surfacing them under the submit form's title field.

**Out of scope — deliberately deferred, with the reason:**

- **Semantic / cross-language matching** (design §5's pgvector half) → needs an embedding model, which is a separate decision about vendor, cost and memory. This plan is the half that needs neither, which is why it is no longer waiting behind that decision.
- **Searching descriptions** → design §5 names them, but a trigram match over prose surfaces an entry because its *description* happens to share letters with the query, which reads as noise at the exact moment a patron is trying to decide whether to submit. Titles and aliases are the identity; descriptions are commentary.
- **Full-text search with stemming** → `to_tsvector` needs a language configuration per row, and the corpus is short titles across many languages where trigram already wins. Trigram handles typos, which is the actual failure mode.
- **Ranking by upvotes or recency** → similarity is the only ordering that answers "did I already suggest this?". Popularity is what the board itself is for.

## Decisions this plan settles

**Candidates come from SQL; visibility comes from the existing read model.** The raw query returns nothing but ids and scores. Those ids are then handed to a Prisma query that composes `visibilityWhere()` — the same function the board uses — so a change to the visibility rules cannot leave search behind. Writing `status <> 'DELETED'` into the SQL would have been shorter and would have silently diverged the first time the rules changed.

**`VIEW`, not `SUBMIT`.** The endpoint spends no external quota and returns only entries the caller could already read on the board. Gating it on `SUBMIT` would deny a free-tier reader the ability to search a board they are allowed to read, for no benefit — and design §5 files this under "de-dupe **+ search**".

**Similarity runs over `normalizedTitle`, not `customTitle`.** `normalizedTitle` is already lowercased and punctuation-stripped — the same normalisation de-duplication uses — so "The Matrix!" and "the matrix" are one trigram target rather than two. Matching the raw title would make casing and punctuation affect the score.

**Catalogue aliases are searched too.** A patron typing "Your Name" should find an entry bound to 君の名は。, because `TitleAlias` already carries that mapping from TMDB. This is the one piece of cross-language matching available without a model, and it comes free.

**The threshold is configuration, not a constant.** Trigram similarity is corpus-dependent; a board of anime titles and a board of podcast links want different cut-offs. It ships with `pg_trgm`'s own default of 0.3.

---

## Task 1: The extension and index

**Files:**

- Modify: `apps/api/prisma/schema.prisma` (declare the extension), `apps/api/src/config/config.schema.ts`
- Create: `apps/api/prisma/migrations/20260820000000_trigram_search/migration.sql`

- [ ] **Step 1: Write the migration**

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN over the de-duplication key, which is already lowercased and punctuation-stripped, so
-- "The Matrix!" and "the matrix" are one trigram target rather than two.
CREATE INDEX "Recommendation_normalizedTitle_trgm_idx"
  ON "Recommendation" USING GIN ("normalizedTitle" gin_trgm_ops);

-- Aliases carry TMDB's translations, which is the only cross-language matching available
-- without an embedding model.
CREATE INDEX "TitleAlias_text_trgm_idx" ON "TitleAlias" USING GIN ("text" gin_trgm_ops);
```

Add `pg_trgm` to the schema's `extensions` list beside `vector`, and
`SEARCH_SIMILARITY_THRESHOLD` (default `0.3`) to the config schema.

- [ ] **Step 2: `migrate deploy`, then `migrate reset --force` so the hand-written file is replayed, not just applied. Commit**

---

## Task 2: The search

**Files:**

- Create: `apps/api/src/recommendations/search.service.ts`
- Modify: `apps/api/src/recommendations/recommendations.service.ts` (export `visibilityWhere` and the projection), `apps/api/src/recommendations/recommendations.controller.ts`, `apps/api/src/recommendations/dto/list-recommendations.query.ts`
- Test: `apps/api/test/board-search.int-spec.ts`

**Interfaces:**

- `GET /creators/:slug/recommendations/similar?q=…` → `{ items: [...] }` in the board's entry shape, `VIEW`.
- `SearchService.similar(creator, query, viewer): Promise<{ items }>`

- [ ] **Step 1: Write the failing test**

```ts
it('finds an entry despite a typo', async () => {
  const res = await search(patron, 'sprited away').expect(200);
  expect(res.body.items.map((i) => i.id)).toContain(spiritedId);
});

it('finds an entry from a fragment of its title', async () => {
  const res = await search(patron, 'totoro').expect(200);
  expect(res.body.items.map((i) => i.id)).toContain(totoroId);
});

it('ignores case and punctuation', async () => {
  // normalizedTitle is the trigram target precisely so these are one string, not three.
  for (const q of ['THE MATRIX', 'the matrix!!', 'The  Matrix']) {
    expect((await search(patron, q).expect(200)).body.items.map((i) => i.id)).toContain(matrixId);
  }
});

it('finds an entry through a catalogue alias in another language', async () => {
  // The one piece of cross-language matching available without an embedding model.
  const res = await search(patron, 'Your Name').expect(200);
  expect(res.body.items.map((i) => i.id)).toContain(kimiNoNaWaId);
});

it('returns nothing for an unrelated query', async () => {
  expect((await search(patron, 'quantum accounting').expect(200)).body.items).toEqual([]);
});

it('orders the closest match first', async () => {
  const res = await search(patron, 'matrix').expect(200);
  expect(res.body.items[0].id).toBe(matrixId);
});

it('never returns a rejected or deleted entry', async () => {
  const res = await search(patron, 'removed thing').expect(200);
  expect(res.body.items).toEqual([]);
});

it('hides another patron pending entry when the creator hides pending', async () => {
  // The same rule as the board, applied by the same function — this is the assertion that
  // proves search did not grow its own copy of the visibility logic.
  await setHidePending(true);
  const res = await search(otherPatron, 'pending thing').expect(200);
  expect(res.body.items).toEqual([]);
});

it('still shows a patron their own pending entry', async () => { ... });

it('shows staff everything', async () => { ... });

it('never returns another creator entries', async () => { ... });

it('refuses a query that is too short, rather than ranking the whole table', async () => {
  await search(patron, 'a').expect(400);
});

it('caps the number of results', async () => { ... });

it('answers an anonymous visitor on a public board', async () => { ... });
```

- [ ] **Step 2: Run, watch fail, implement**

```ts
const rows = await this.prisma.$queryRaw<Array<{ id: string; score: number }>>`
  SELECT r."id",
         GREATEST(
           similarity(r."normalizedTitle", ${normalized}),
           COALESCE(MAX(similarity(a."text", ${query})), 0)
         ) AS score
  FROM "Recommendation" r
  LEFT JOIN "TitleAlias" a ON a."titleId" = r."titleId"
  WHERE r."creatorId" = ${creator.id}::uuid
    AND (r."normalizedTitle" % ${normalized} OR a."text" % ${query})
  GROUP BY r."id", r."normalizedTitle"
  ORDER BY score DESC
  LIMIT ${MAX_RESULTS}
`;
```

Then the ids go through a Prisma query composing `visibilityWhere()` and the board's projection,
re-ordered to match the score order — the same shape as the review queue's ordering.

- [ ] **Step 3: Run and commit**

---

## Task 3: The SPA

**Files:**

- Create: `apps/web/src/components/SimilarEntries.tsx`
- Modify: `apps/web/src/components/SubmitForm.tsx`, `apps/web/src/api/hooks.ts`
- Test: `apps/web/src/components/SimilarEntries.test.tsx`, `SubmitForm.test.tsx` (extend)

- [ ] **Step 1: Write the failing tests**

`SimilarEntries`: renders nothing below the minimum query length; debounces; renders matches with an
upvote control rather than only a name, because "it is already there" is useless without "so upvote
it"; renders nothing when there are no matches rather than an empty box; a failed lookup renders
nothing rather than an error, since this is an aid and not the task; titles containing markup
render as text.

`SubmitForm`: typing a title that matches an existing entry shows it; picking a catalogue result
does not trigger the search, because the canonical de-dupe already covers that case exactly.

- [ ] **Step 2: Implement, run, commit**

---

## Task 4: End-to-end and verification

**Files:**

- Modify: `e2e/tests/journey.spec.ts`, `README.md`

- [ ] **Step 1: Add the journey**

A patron types a misspelling of something already on the board, sees it offered, upvotes it from
there, and never submits a duplicate.

- [ ] **Step 2: Full verification**

```bash
pnpm -r typecheck && pnpm -r test && pnpm format:check
docker-compose -f docker-compose.e2e.yml up -d --build && pnpm --filter e2e e2e
```

- [ ] **Step 3: Document the search in the README, commit**

---

## Self-Review

**Spec coverage (design §5 "Already submitted? (de-dupe + search)"):**

- "live search … over aliases/`customTitle`" using Postgres `pg_trgm` → Tasks 1–2. ✅
- "surface existing/similar entries before submit" → Task 3. ✅
- Canonical de-dupe on `unique(creatorId, titleId, type)` → already shipped in Plan 08; unchanged. ✅
- "…and pgvector nearest-neighbor (semantic, cross-language)" → **deferred**, with the reason in Scope. Aliases give a partial, free substitute. ✅
- Searching descriptions → **not built**, with the reason in Scope.

## Found in review (fixed)

1. **Important — neither GIN index was used; every search was a sequential scan.** The plan
   specified the `%` operator; the implementation shipped `similarity(...) >= threshold`, which is
   not indexable in a `WHERE` clause. Measured on 100k rows: **444ms sequential versus 0.045ms
   indexed**. Both indexes were pure write amplification on the two highest-insert tables.
2. **Important — `similarity()` is the wrong metric for a type-ahead.** It penalises the length of
   the target, so "spirited" scored **0.26** against "Spirited Away in the Land of the Gods" and
   "neigh" scored 0.24 against "My Neighbour Totoro" — below any usable threshold. Every fixture
   title was two or three short words, so the tests could not see it. Now `word_similarity` /
   `<%`, which asks "is the query a fragment of the target" and is indexable — one change fixing
   both findings.
3. **Important — an anonymous, repeatable 500 from a crafted query.** The *raw* string was bound
   to the alias comparison while only the other parameter was normalised, so a NUL byte reached
   Postgres as `22021`, mapped to an unhandled `P2010`, and logged at error level on every
   request. Both comparisons now take the normalised string, and the DTO rejects control
   characters.
4. **Important — hidden entries crowded visible ones out entirely.** The candidate `LIMIT` ran
   *before* the visibility filter, so eight rejected near-duplicates — exactly what moderating
   spam on a popular title produces, and `DELETED` rows accumulate forever — made search return
   **nothing** for that title, permanently, letting through the duplicate the feature exists to
   prevent. The plan called this "under-reporting"; it was total failure. Candidates are now
   over-fetched and sliced after filtering.
5. **Important — no bound on the worst case** on an endpoint reachable anonymously and fired every
   250ms of typing. A 200-character query cost ~370ms of CPU across three parallel workers. The
   indexable query removes most of it; a transaction-scoped `statement_timeout` bounds the rest.
6. **Minor, also fixed:** the response was not actually the board's shape despite the README
   saying so (missing `availability`, `parentId`, `themes`); Prisma would have dropped both
   indexes on the next `migrate dev` because they existed only in raw SQL; `visibilityWhere` was
   spread rather than `AND`-composed, the exact shape that once silently overwrote the board's own
   filter; the threshold's comment was spliced into the middle of an unrelated setting's; the
   debounce test passed with the interval set to zero; and the result-cap test passed on an empty
   list, which is precisely the failure in (4).

**Known risks:**

1. **Trigram similarity is corpus-dependent.** 0.3 is `pg_trgm`'s default, not a tuned value; a board of long titles will match more loosely than one of short ones. It is configuration precisely because the right value is an operational question, but nothing currently tells an operator that their threshold is wrong.
2. **The candidate query is still not visibility-filtered**, it is merely over-fetched by six
   times the result cap before slicing. A board where more than forty-eight hidden entries
   out-rank every visible one for a query would still under-report. Filtering in SQL would fix it
   completely and reintroduce exactly the duplication this plan exists to avoid; the multiplier is
   the compromise.
3. **A GIN trigram index is large and slows writes.** Two of them, on the two tables that take the most inserts. Acceptable at Phase 1 volumes; worth measuring before a board has a million entries.
4. **The search runs on every keystroke past the minimum**, debounced client-side only. There is no rate limit on it — it is a local read, but it is an unauthenticated-adjacent one on a public board.
