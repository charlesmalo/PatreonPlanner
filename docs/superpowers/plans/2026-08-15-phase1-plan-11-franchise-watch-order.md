# Franchise & Watch Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete design §5's five content classes — a patron can suggest a whole franchise, or an ordered watch order, not only single films and shows.

**Architecture:** A TMDB *collection* is another kind of canonical identity, so `FRANCHISE` binds a `Title` row with `mediaType = COLLECTION` and reuses every piece of machinery films already have: de-duplication, availability skipping, the catalogue cache. `WATCH_ORDER` has no upstream identity at all — it is a curated sequence — so it binds nothing and carries ordered `WatchOrderItem` rows, each optionally bound to a real `Title`.

**Tech Stack:** NestJS 10, Prisma 5.20, Postgres, React 18 (all existing; no new dependencies).

## Global Constraints

- **Every user string still passes moderation** (design §6.5). Watch-order item titles and notes are user-controlled text on a public board and are not an exemption.
- **A submission that cannot be resolved is a 400, never an unresolvable row.** A `FRANCHISE` with an id TMDB does not know must not persist.
- **De-duplication stays enforced by the database**, not by a read-then-write check.
- **The SPA never gates security.** The type picker is a convenience; the API validates every field.
- **No `dangerouslySetInnerHTML`.** Item titles and notes are attacker-chosen.
- **Bounded input:** a watch order is capped at 50 items, matching the existing 5-link cap in spirit — an unbounded list is an unbounded write.

## Scope

**In scope:** the `COLLECTION` media type and collection lookup, the `WatchOrderItem` model, submitting and reading both new types, and the SPA for composing and rendering them.

**Out of scope — deliberately deferred, with the reason:**

- **`TitleRelation` and automatic nesting** ("submitting Season 2 nests under the existing show", design §5) → needs the relationship graph, which is the catalog-intelligence plan. This plan lets a patron *state* a franchise; it does not infer one.
- **Themes and grouped board views** → same plan, same reason.
- **Availability for a franchise** → TMDB has no watch-providers endpoint for a collection. The parts have availability individually; showing a franchise's availability means deciding what the union of its parts means, which is a product question nobody has asked yet.
- **Editing a watch order after submission** → the board has no edit affordance for a submitter at all yet (only staff redaction). Adding one for this type only would be an odd exception.
- **Semantic/fuzzy pre-submit de-dupe** (design §5) → needs pgvector and `pg_trgm`; the canonical unique index is what this plan relies on.

## Decisions this plan settles

**A TMDB collection is a `Title` with `mediaType = COLLECTION`.** The alternative — a separate `Collection` model — would need its own de-dupe index, its own cache, its own availability skip and its own board projection, all parallel to what `Title` already has. TMDB ids are only unique within a media type, and the existing `@@unique([tmdbId, mediaType])` already accounts for that, so a collection with id 123 and a film with id 123 stay distinct.

**`WATCH_ORDER` binds no canonical title and de-duplicates on its normalized name**, exactly like `EXTERNAL_LINK`. Two people's "Chronological Star Wars" are the same suggestion for a creator's purposes; two people's *differently ordered* Star Wars are a disagreement to have in the comments, not two board entries.

**Watch-order items may be catalogue-bound or free text.** Requiring TMDB for every entry would make "and then the fan edit" unexpressible; forbidding it would throw away the poster and canonical name for the ones TMDB does know. Each item carries `titleId` or `customTitle`, never both, never neither.

**Position is stored explicitly and normalised on write.** The client sends items in order; the server numbers them 0..n-1 rather than trusting a client-supplied `position`. A duplicated or sparse position from a buggy client would otherwise render an ambiguous order.

---

## Task 1: Collection lookup in the catalogue provider

**Files:**

- Modify: `apps/api/prisma/schema.prisma` (add `COLLECTION` to `MediaType`), `apps/api/src/catalog/catalog.provider.ts`, `apps/api/src/catalog/tmdb-catalog.provider.ts`, `apps/api/src/catalog/catalog.service.ts`, `apps/api/test/support/fake-catalog.provider.ts`
- Create: `apps/api/prisma/migrations/20260815000000_collection_media_type/migration.sql`
- Test: `apps/api/test/catalog-collections.e2e-spec.ts`

**Interfaces:**

- `CatalogProvider.fetchTitle(tmdbId, mediaType)` already takes a `MediaType`; `COLLECTION` routes to `/collection/{id}`.
- `CatalogProvider.search` gains collections from TMDB's `search/collection`.

- [ ] **Step 1: Write the failing test**

```ts
it('fetches a TMDB collection as a title', async () => {
  stubJson({ id: 10, name: 'Star Wars Collection', overview: 'A galaxy…', poster_path: '/sw.jpg' });
  const result = await provider.fetchTitle(10, 'COLLECTION');
  expect(result).toEqual({
    tmdbId: 10,
    mediaType: 'COLLECTION',
    name: 'Star Wars Collection',
    // A collection has no single release date, and inventing one from its parts would be a guess.
    year: null,
    posterPath: '/sw.jpg',
    overview: 'A galaxy…',
  });
});

it('returns null for a collection TMDB does not know', async () => {
  stubStatus(404);
  expect(await provider.fetchTitle(999, 'COLLECTION')).toBeNull();
});

it('includes collections in search results', async () => {
  // TMDB's search/multi does not return collections; they need their own call.
  stubSearch({ multi: [movie], collection: [{ id: 10, name: 'Star Wars Collection' }] });
  const results = await provider.search('star wars');
  expect(results.some((r) => r.mediaType === 'COLLECTION')).toBe(true);
});

it('still returns film results when the collection search fails', async () => {
  // Two upstream calls; one failing must degrade, not empty the autocomplete.
  stubSearch({ multi: [movie], collectionFails: true });
  expect((await provider.search('star wars')).length).toBe(1);
});
```

- [ ] **Step 2: Add `COLLECTION` to the enum and write the migration by hand**

```sql
ALTER TYPE "MediaType" ADD VALUE 'COLLECTION';
```

`ALTER TYPE … ADD VALUE` cannot run inside a transaction block in Postgres before 12, and Prisma
wraps migrations in one. On 16 it is allowed, but the new value cannot be *used* in the same
transaction — which is fine here because nothing writes it in this migration.

- [ ] **Step 3: Implement, run, commit**

---

## Task 2: The WatchOrderItem model

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260815010000_watch_order_items/migration.sql`

```prisma
model WatchOrderItem {
  id               String   @id @default(uuid()) @db.Uuid
  recommendationId String   @db.Uuid
  // Normalised on write to 0..n-1; a client-supplied position is not trusted, because a
  // duplicated or sparse one renders an ambiguous order.
  position         Int
  // Bound to the catalogue when TMDB knows the entry, free text when it does not — "and then
  // the fan edit" has to be expressible.
  titleId          String?  @db.Uuid
  customTitle      String?
  note             String?
  createdAt        DateTime @default(now())

  recommendation Recommendation @relation(fields: [recommendationId], references: [id], onDelete: Cascade)
  title          Title?         @relation(fields: [titleId], references: [id])

  @@unique([recommendationId, position])
  @@index([recommendationId])
  @@index([titleId])
}
```

Add `watchOrderItems WatchOrderItem[]` to `Recommendation` and `watchOrderItems WatchOrderItem[]`
to `Title`.

- [ ] **Steps: add the model, write the migration, `migrate deploy`, `migrate reset --force` to prove it replays, commit**

---

## Task 3: Submitting a franchise

**Files:**

- Modify: `apps/api/src/recommendations/dto/submit-recommendation.dto.ts`, `apps/api/src/recommendations/recommendations.service.ts`
- Test: `apps/api/test/franchise-submit.int-spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('binds a franchise to a TMDB collection', async () => {
  const res = await submit(patron, { type: 'FRANCHISE', tmdbId: 10 }).expect(201);
  expect(res.body.recommendation.customTitle).toBe('Star Wars Collection');
  expect(res.body.recommendation.title.mediaType).toBe('COLLECTION');
});

it('rejects a franchise TMDB does not know', async () => {
  await submit(patron, { type: 'FRANCHISE', tmdbId: 999999 }).expect(400);
  expect(await countEntries()).toBe(0);
});

it('de-duplicates a franchise against the same collection', async () => {
  await submit(patron, { type: 'FRANCHISE', tmdbId: 10 }).expect(201);
  const res = await submit(otherPatron, { type: 'FRANCHISE', tmdbId: 10 }).expect(200);
  expect(res.body.duplicate).toBe(true);
});

it('keeps a franchise distinct from a film with the same TMDB id', async () => {
  // TMDB ids are only unique within a media type; the unique index is (creatorId, titleId, type)
  // and the Title rows differ, so both must be able to exist.
  await submit(patron, { type: 'MOVIE', tmdbId: 10 }).expect(201);
  await submit(otherPatron, { type: 'FRANCHISE', tmdbId: 10 }).expect(201);
});

it('refuses a customTitle on a franchise', async () => {
  await submit(patron, { type: 'FRANCHISE', tmdbId: 10, customTitle: 'Mine' }).expect(400);
});
```

- [ ] **Step 2: Implement**

`MAINSTREAM` becomes `['MOVIE', 'SHOW', 'FRANCHISE']`, and `resolveTitle` maps the type to a media
type: `SHOW → TV`, `FRANCHISE → COLLECTION`, otherwise `MOVIE`.

- [ ] **Step 3: Run and commit**

---

## Task 4: Submitting a watch order

**Files:**

- Modify: `apps/api/src/recommendations/dto/submit-recommendation.dto.ts`, `apps/api/src/recommendations/recommendations.service.ts`
- Test: `apps/api/test/watch-order-submit.int-spec.ts`

**Interfaces:**

```ts
export class WatchOrderItemDto {
  @IsOptional() @IsInt() @IsPositive() tmdbId?: number;
  @IsOptional() @IsIn(['MOVIE', 'SHOW']) mediaType?: 'MOVIE' | 'SHOW';
  @IsOptional() @IsString() @Length(1, 200) customTitle?: string;
  @IsOptional() @IsString() @Length(1, 500) note?: string;
}
```

- [ ] **Step 1: Write the failing test**

```ts
it('stores items in the order they were sent', async () => {
  const res = await submit(patron, {
    type: 'WATCH_ORDER',
    customTitle: 'Chronological Star Wars',
    items: [{ customTitle: 'The Phantom Menace' }, { customTitle: 'Attack of the Clones' }],
  }).expect(201);
  expect(res.body.recommendation.watchOrderItems.map((i) => i.customTitle)).toEqual([
    'The Phantom Menace',
    'Attack of the Clones',
  ]);
  expect(res.body.recommendation.watchOrderItems.map((i) => i.position)).toEqual([0, 1]);
});

it('binds an item to the catalogue when it carries a tmdbId', async () => {
  const res = await submit(patron, {
    type: 'WATCH_ORDER',
    customTitle: 'Order',
    items: [{ tmdbId: 129, mediaType: 'MOVIE' }],
  }).expect(201);
  expect(res.body.recommendation.watchOrderItems[0].title.name).toBe('Spirited Away');
});

it('requires a watch order to have at least one item', async () => {
  await submit(patron, { type: 'WATCH_ORDER', customTitle: 'Empty', items: [] }).expect(400);
});

it('caps a watch order at fifty items', async () => {
  const items = Array.from({ length: 51 }, (_, i) => ({ customTitle: `Item ${i}` }));
  await submit(patron, { type: 'WATCH_ORDER', customTitle: 'Long', items }).expect(400);
});

it('refuses an item that is neither bound nor titled', async () => {
  await submit(patron, { type: 'WATCH_ORDER', customTitle: 'X', items: [{ note: 'hm' }] })
    .expect(400);
});

it('refuses an item that is both bound and titled', async () => {
  await submit(patron, {
    type: 'WATCH_ORDER',
    customTitle: 'X',
    items: [{ tmdbId: 129, mediaType: 'MOVIE', customTitle: 'Mine' }],
  }).expect(400);
});

it('moderates item titles and notes', async () => {
  // Design §6.5 puts every user string through the pipeline. Item text is exactly the place a
  // submitter would try to route around a title-only check.
  await submit(patron, {
    type: 'WATCH_ORDER',
    customTitle: 'Fine',
    items: [{ customTitle: 'this is shit' }],
  }).expect(400);
  await submit(patron, {
    type: 'WATCH_ORDER',
    customTitle: 'Fine',
    items: [{ customTitle: 'ok', note: 'this is shit' }],
  }).expect(400);
});

it('rejects an unknown tmdbId on an item without persisting the entry', async () => {
  await submit(patron, {
    type: 'WATCH_ORDER',
    customTitle: 'X',
    items: [{ tmdbId: 999999, mediaType: 'MOVIE' }],
  }).expect(400);
  expect(await countEntries()).toBe(0);
});

it('rejects items on a type that is not a watch order', async () => {
  await submit(patron, { type: 'MOVIE', tmdbId: 129, items: [{ customTitle: 'x' }] }).expect(400);
});
```

- [ ] **Step 2: Implement**

Items are resolved *before* the entry is created and written in the same transaction as it, so a
half-written watch order cannot exist. Item moderation joins the existing `review()` call, which
already takes an array of strings — the parts simply grow.

- [ ] **Step 3: Run and commit**

---

## Task 5: Reading them back

**Files:**

- Modify: `apps/api/src/recommendations/recommendations.service.ts`, `apps/api/src/moderation/review-queue.service.ts`
- Test: `apps/api/test/watch-order-submit.int-spec.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
it('returns watch-order items in position order on the board', async () => {
  const res = await board(patron).expect(200);
  const entry = res.body.items.find((i) => i.type === 'WATCH_ORDER');
  expect(entry.watchOrderItems.map((i) => i.position)).toEqual([0, 1, 2]);
});

it('omits the items array on types that cannot have one', async () => {
  const res = await board(patron).expect(200);
  const movie = res.body.items.find((i) => i.type === 'MOVIE');
  expect(movie.watchOrderItems).toEqual([]);
});

it('shows a moderator the items so they can be reviewed', async () => {
  // A watch order's text is mostly *in* its items; a review queue that hid them would be
  // reviewing a title and nothing else.
  const res = await queue(staff).expect(200);
  expect(res.body.items[0].watchOrderItems.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Implement, run, commit**

---

## Task 6: The SPA

**Files:**

- Create: `apps/web/src/components/WatchOrderEditor.tsx`, `apps/web/src/components/WatchOrderList.tsx`
- Modify: `apps/web/src/components/SubmitForm.tsx`, `apps/web/src/components/RecommendationCard.tsx`, `apps/web/src/api/types.ts`, `apps/web/src/test-support.tsx`
- Test: `apps/web/src/components/WatchOrderEditor.test.tsx`, `apps/web/src/components/WatchOrderList.test.tsx`, `SubmitForm.test.tsx` (extend)

- [ ] **Step 1: Write the failing tests**

Submit form: a labelled type picker offering all four submittable classes; choosing **Franchise**
searches collections and posts `{ type: 'FRANCHISE', tmdbId }`; choosing **Watch order** reveals
the editor and posts the items in order; the catalogue search box is hidden for a watch order's
*outer* title, which is free text.

Editor: adds an item, removes an item, moves an item up and down, and renumbering is implied by
order in the array rather than a position field; the "move up" control is absent on the first row;
every control has an accessible name including which item it acts on; a catalogue-bound item shows
its canonical name; an empty editor blocks submission client-side.

List: renders items in order with a visible index; a bound item shows its poster and canonical
name; a free-text item shows its text; notes render as text; an item title containing markup is not
parsed as HTML.

- [ ] **Step 2: Implement, run, commit**

---

## Task 7: End-to-end and verification

**Files:**

- Modify: `e2e/stub/patreon-stub.mjs` (collection routes), `e2e/tests/journey.spec.ts`, `README.md`

- [ ] **Step 1: Add the journeys**

1. A patron suggests a franchise from the catalogue and sees it on the board.
2. A patron composes a three-item watch order, reorders it, submits, and the board shows the final
   order.

- [ ] **Step 2: Full verification**

```bash
pnpm -r typecheck && pnpm -r test && pnpm format:check
docker-compose -f docker-compose.e2e.yml up -d --build && pnpm --filter e2e e2e
```

- [ ] **Step 3: Document the content classes in the README, commit**

---

## Self-Review

**Spec coverage (design §5 content classes and submit flow):**

- `MOVIE | SHOW | FRANCHISE | WATCH_ORDER` all submittable, TMDB-validated → Tasks 1, 3, 4. ✅
- "`FRANCHISE` binds to a TMDB collection" → Task 1, 3. ✅
- "watch-order = ordered `WatchOrderItem`s" → Tasks 2, 4. ✅
- Rate limit → moderation → persist as `PENDING`, for the new types too → Task 4 reuses the existing pipeline. ✅
- Canonical de-dupe `unique(creatorId, titleId, type)` covering franchises → Task 3. ✅
- "and/or curated group of titles" (the non-TMDB half of `FRANCHISE`) → **not built.** A franchise binds a collection only. A curated group with no TMDB collection is expressible today as a `WATCH_ORDER`, which is the same data with an order nobody has to honour.
- Ambiguous → return candidates to pick → already how `catalog/search` works; unchanged.
- Nesting, themes, semantic de-dupe → **deferred** to the catalog-intelligence plan.

## Found in review (fixed)

1. **Important — `WATCH_ORDER` and `EXTERNAL_LINK` shared one de-dupe namespace.** The unbound
   partial index is `(creatorId, normalizedTitle)` with no `type` column — harmless while external
   links were the only unbound class. A watch order named like an existing link resolved to *that
   link*: the submitter was told "already on the board", all their steps were silently discarded,
   and they were handed a link card in reply. The README table in this very plan documented the
   two as separate keys. Fixed by a new migration and a matching service filter.
2. **Important — a franchise got a *film's* streaming availability.** `COLLECTION` fell through to
   `/movie/{id}/watch/providers`, and TMDB ids are unique only within a media type — so the call
   succeeded and attributed a different work's offers to the franchise. Deferring franchise
   availability means skipping the lookup, not mis-routing it. Now skipped at both layers.
3. **Important — the `P2002` handler swallowed unrelated unique violations.** Moving item
   resolution inside `create()` put `Title` upserts inside the catch that reads any `P2002` as
   "someone won the de-dupe race" — which would have refunded the limit and thrown `P2025` on a
   valid submission. Item resolution is hoisted out, and the handler now rethrows when no winner
   exists.
4. **Important — a duplicate watch order skipped all item validation.** The same body was a 400
   with a fresh name and a 200 with a taken one. Fixed by the same hoist.
5. **Important — fifty steps meant fifty simultaneous TMDB calls**, uncached, which trips the
   upstream rate limit and exhausts the connection pool. Worse, `fetchTitle` swallowed *every*
   error as "unknown title", so a 429 told the patron their valid submission contained a title
   that does not exist. Now sequential, and 404 is distinguished from failure.
6. **Important — the review queue exposed items over the API but never rendered them.** This
   plan's own Known Risk 3 asserted "the review queue now shows the items"; end to end it did not.
7. **Important — no way to compose a catalogue-bound step.** Nothing in the SPA ever set `tmdbId`,
   so the bound branch was unreachable in production and half of "steps may be catalogue-bound"
   was API-only. Each step now has catalogue suggestions.
8. **Minor, also fixed:** `mediaType` was optional beside `tmdbId`, so a series id silently bound
   a film; a whitespace-only step title persisted as an invisible step; the link field stayed
   visible in watch-order mode while never being sent; the fifty-step cap was not mirrored
   client-side; `search/collection` omitted `include_adult=false`; and two tests were vacuous —
   one asserted the opposite of its own name and would have passed with the feature deleted.

**Behaviour change worth noting:** `customTitle` on a `MOVIE`/`SHOW`/`FRANCHISE` is now a 400
rather than accepted-and-ignored. Correct — silently discarding it lets a submitter believe they
named the entry — but it is a breaking change for any client other than this SPA.

**Known risks:**

0. **The duplicate path still refunds the rate limit after spending a TMDB call and a full
   moderation pass.** A patron can replay a known-duplicate watch order indefinitely at zero
   limit cost, driving 101 moderation reviews per request — against the stated intent that "a
   flood must not be able to drive that cost". Pre-existing, but this plan enlarges the blast
   radius; it belongs with the abuse-scoring work.
1. **`ALTER TYPE … ADD VALUE` is not reversible.** Postgres cannot drop an enum value, so rolling this migration back means recreating the type. Acceptable for a value that is only ever added.
2. **A watch order's items are not de-duplicated against each other.** Listing the same film twice is legal, and sometimes correct (a rewatch mid-order), so this is deliberate — but it also means a bored submitter can pad fifty entries with one title.
3. **Item moderation reviews text but not the *composition*.** Fifty items each individually clean can still be an abusive sequence read as a whole. That is a human-review problem, and the review queue now shows the items.
4. **A collection's parts are not stored.** The board shows the franchise as one card with TMDB's name and poster; it does not list what is in it. Listing parts needs `TitleRelation`, which is the deferred plan.
