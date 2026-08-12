# Catalog Intelligence I — Relations & Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a board understand that its entries are related — a season belongs to its show, a film belongs to its franchise, and everything carries themes you can filter by.

**Architecture:** Relations and themes are **global facts about titles**, derived from TMDB's structured data and stored once. *Nesting* is a **per-board projection** computed at read time, because whether an entry has a parent depends on what else is on that board — a fact that changes every time someone submits. Building relations is a background job triggered by binding, so a submit never waits on three extra TMDB calls.

**Tech Stack:** NestJS 10, Prisma 5.20, Postgres, BullMQ, React 18 (all existing; no new dependencies).

## Global Constraints

- **No new third-party dependency.** Everything here comes from TMDB endpoints the project already calls, with the same key.
- **A missing `TMDB_API_KEY` degrades to no relations and no themes.** The board still renders, unnested and unfiltered.
- **Relations are directional and stored once per ordered pair**, so "A is a season of B" is not confusable with the reverse.
- **Theme names are shown on a public board**; a creator-supplied rename passes moderation like any other user string.
- **No `dangerouslySetInnerHTML`.** Theme names are creator-editable text.
- **Every relation-building call is bounded and idempotent** — a re-run must not multiply rows.

## Scope

**In scope:** the `TitleRelation` graph built from TMDB collections, TV seasons and similar-title data; the `Theme`/`TitleTheme` taxonomy seeded from TMDB genres and keywords; creator curation of theme names and assignments; nesting and theme filtering on the board; the SPA for both.

**Out of scope — deliberately deferred, with the reason:**

- **Embeddings, semantic de-dupe, and personalised ranking** (design §5) → these need an embedding vendor, a key and a budget nobody has chosen. Every other external dependency in this project sits behind an interface that degrades when unconfigured, and the honest version of that here is a **separate plan written once a provider is picked** — not a half-built interface with no implementation behind it. `RELATED` therefore comes from TMDB's own similar-titles endpoint only; design §5's "+ embedding proximity" waits.
- **Theme merging** → renaming and reassigning cover the correction cases. Merging needs a conflict policy for entries carrying both themes, and that policy is easier to choose once creators have used themes for a while.
- **Embedding-driven theme expansion** (design §5) → same dependency, same plan.
- **Cross-page nesting** → see Known Risks. A child whose parent is on another page renders unnested rather than wrongly nested.

## Decisions this plan settles

**Relations are global; nesting is per-board.** `TitleRelation` records that *Season 2 is a season of Show X* — true everywhere, forever. Whether Season 2 *nests* depends on whether Show X is also on this particular board, which is a read-time question. Storing a `parentRecommendationId` would have to be recomputed on every submission and every status change, and would be wrong the moment a parent is rejected.

**Relation building happens in a job, not in the submit path.** Binding a title needs up to three more TMDB calls (collection parts, seasons, similar). Design §5's submit flow is already rate-limit → moderate → persist; adding three network calls to it makes the slowest, most abusable path slower still. The job is triggered by a new binding and is idempotent.

**A relation is stored once, in one direction, with a canonical ordering.** `SEASON_OF` and `SAME_FRANCHISE` point from the *member* to the *container*. Storing both directions would double the rows and let them disagree; the read model walks it in whichever direction it needs.

**Themes are creator-scoped, seeded globally.** TMDB genres and keywords are facts about a title and shared by everyone; what a creator *calls* a theme and which ones they surface is theirs. `Theme` therefore carries a `creatorId`, and seeding copies the global fact into each creator's namespace the first time a title lands on their board.

**Theme filtering is a query parameter, not a separate endpoint.** `GET /creators/:slug/recommendations?theme=<id>` narrows the same read model with the same visibility rules. A second endpoint would be a second place for those rules to drift.

---

## Task 1: The relation and theme models

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260816000000_relations_and_themes/migration.sql`

```prisma
enum RelationKind {
  SEASON_OF
  SEQUEL
  PREQUEL
  SAME_FRANCHISE
  RELATED
}

model TitleRelation {
  id        String       @id @default(uuid()) @db.Uuid
  // Direction matters: from the member to the container for SEASON_OF and SAME_FRANCHISE.
  fromId    String       @db.Uuid
  toId      String       @db.Uuid
  kind      RelationKind
  // TMDB's own ordering within a collection or season list, for rendering.
  ordinal   Int?
  createdAt DateTime     @default(now())

  from Title @relation("RelationFrom", fields: [fromId], references: [id], onDelete: Cascade)
  to   Title @relation("RelationTo", fields: [toId], references: [id], onDelete: Cascade)

  // Idempotent by construction: re-running the builder cannot multiply rows.
  @@unique([fromId, toId, kind])
  @@index([fromId])
  @@index([toId])
}

model Theme {
  id        String   @id @default(uuid()) @db.Uuid
  creatorId String   @db.Uuid
  // What the creator calls it. Seeded from TMDB, then theirs to rename.
  name      String
  // Lowercased name, for the uniqueness check — two themes differing only in case are one theme.
  slug      String
  // The TMDB genre or keyword this was seeded from; null once a creator invents one.
  sourceKey String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  creator Creator      @relation(fields: [creatorId], references: [id], onDelete: Cascade)
  titles  TitleTheme[]

  @@unique([creatorId, slug])
  @@index([creatorId])
}

model TitleTheme {
  titleId String @db.Uuid
  themeId String @db.Uuid

  title Title @relation(fields: [titleId], references: [id], onDelete: Cascade)
  theme Theme @relation(fields: [themeId], references: [id], onDelete: Cascade)

  @@id([titleId, themeId])
  @@index([themeId])
}
```

Add the back-relations to `Title` and `Creator`.

- [ ] **Steps: add the models, hand-write the migration following `20260813000000_moderation_lifecycle`, `migrate deploy`, `migrate reset --force` to prove it replays, commit**

Add a check constraint the schema cannot express:

```sql
-- A title is not related to itself, and a self-relation would nest an entry under itself.
ALTER TABLE "TitleRelation" ADD CONSTRAINT "TitleRelation_no_self"
  CHECK ("fromId" <> "toId");
```

---

## Task 2: TMDB structure lookups

**Files:**

- Modify: `apps/api/src/catalog/catalog.provider.ts`, `apps/api/src/catalog/tmdb-catalog.provider.ts`, `apps/api/test/support/fake-catalog.provider.ts`
- Test: `apps/api/test/catalog-structure.e2e-spec.ts`

**Interfaces:**

```ts
export interface TitleStructure {
  /** Collection this title belongs to, from a film's `belongs_to_collection`. */
  collection: { tmdbId: number; name: string } | null;
  /** Parts of a collection, in TMDB's order. Only for a COLLECTION lookup. */
  parts: Array<{ tmdbId: number; mediaType: 'MOVIE'; ordinal: number }>;
  /** TMDB's similar titles, capped. */
  similar: Array<{ tmdbId: number; mediaType: MediaType }>;
  /** Genre and keyword labels, for theme seeding. */
  labels: string[];
}

CatalogProvider.fetchStructure(tmdbId: number, mediaType: MediaType): Promise<TitleStructure>
```

- [ ] **Step 1: Write the failing test**

```ts
it('reads a film collection membership and its labels', async () => {
  stubRoutes({
    '/movie/129': {
      body: {
        id: 129,
        belongs_to_collection: { id: 10, name: 'Ghibli Collection' },
        genres: [{ name: 'Animation' }, { name: 'Fantasy' }],
      },
    },
    '/movie/129/keywords': { body: { keywords: [{ name: 'anime' }] } },
    '/movie/129/similar': { body: { results: [{ id: 8392 }] } },
  });
  const structure = await provider.fetchStructure(129, 'MOVIE');
  expect(structure.collection).toEqual({ tmdbId: 10, name: 'Ghibli Collection' });
  expect(structure.labels).toEqual(['Animation', 'Fantasy', 'anime']);
  expect(structure.similar).toEqual([{ tmdbId: 8392, mediaType: 'MOVIE' }]);
});

it('reads a collection parts in order', async () => {
  stubRoutes({ '/collection/10': { body: { id: 10, parts: [{ id: 1 }, { id: 2 }] } } });
  const structure = await provider.fetchStructure(10, 'COLLECTION');
  expect(structure.parts).toEqual([
    { tmdbId: 1, mediaType: 'MOVIE', ordinal: 0 },
    { tmdbId: 2, mediaType: 'MOVIE', ordinal: 1 },
  ]);
});

it('uses the tv keyword shape, which differs from a film', async () => {
  // TMDB returns `keywords` for a film and `results` for a series, under the same path.
  stubRoutes({
    '/tv/1': { body: { id: 1, genres: [] } },
    '/tv/1/keywords': { body: { results: [{ name: 'k-drama' }] } },
    '/tv/1/similar': { body: { results: [] } },
  });
  expect((await provider.fetchStructure(1, 'TV')).labels).toEqual(['k-drama']);
});

it('caps similar titles', async () => {
  stubRoutes({ /* 40 similar results */ });
  expect((await provider.fetchStructure(129, 'MOVIE')).similar).toHaveLength(SIMILAR_CAP);
});

it('degrades to an empty structure when a sub-call fails', async () => {
  // Relations are garnish. One failing endpoint must not deny the whole title its collection.
  stubRoutes({ '/movie/129': { body: { id: 129, genres: [] } }, '/movie/129/keywords': { status: 500 } });
  await expect(provider.fetchStructure(129, 'MOVIE')).resolves.toMatchObject({ labels: [] });
});

it('throws when the title itself cannot be read', async () => {
  stubRoutes({ '/movie/129': { status: 500 } });
  await expect(provider.fetchStructure(129, 'MOVIE')).rejects.toThrow();
});
```

- [ ] **Step 2: Run, watch fail, implement, commit**

---

## Task 3: Building the graph

**Files:**

- Create: `apps/api/src/intelligence/intelligence.module.ts`, `apps/api/src/intelligence/relations.service.ts`, `apps/api/src/intelligence/themes.service.ts`, `apps/api/src/jobs/enrich-title.job.ts`
- Modify: `apps/api/src/jobs/jobs.module.ts`, `apps/api/src/recommendations/recommendations.service.ts` (mark a title for enrichment)
- Modify: `apps/api/prisma/schema.prisma` (`Title.enrichedAt DateTime?`)
- Test: `apps/api/test/enrichment.int-spec.ts`

**Interfaces:**

- `RelationsService.enrich(titleId: string): Promise<void>` — writes relations and themes for one title.
- `EnrichTitleJob.runOnce(): Promise<number>` — enriches the oldest un-enriched titles.

- [ ] **Step 1: Write the failing test**

```ts
it('records a film as a member of its collection', async () => {
  await service.enrich(filmId);
  const relation = await prisma.titleRelation.findFirstOrThrow({ where: { fromId: filmId } });
  expect(relation.kind).toBe('SAME_FRANCHISE');
  // The collection is created as a Title if it is not already one.
  const collection = await prisma.title.findUniqueOrThrow({ where: { id: relation.toId } });
  expect(collection.mediaType).toBe('COLLECTION');
});

it('records collection parts pointing at the collection, in order', async () => {
  await service.enrich(collectionId);
  const relations = await prisma.titleRelation.findMany({
    where: { toId: collectionId }, orderBy: { ordinal: 'asc' },
  });
  expect(relations.map((r) => r.ordinal)).toEqual([0, 1]);
});

it('is idempotent', async () => {
  await service.enrich(filmId);
  await service.enrich(filmId);
  expect(await prisma.titleRelation.count({ where: { fromId: filmId } })).toBe(2);
});

it('never relates a title to itself', async () => {
  // TMDB's similar list can include the title itself; a self-relation nests an entry under
  // itself and the read model would loop.
  fakeCatalog.structure = { similar: [{ tmdbId: OWN_TMDB_ID, mediaType: 'MOVIE' }], ... };
  await service.enrich(filmId);
  expect(await prisma.titleRelation.count({ where: { fromId: filmId, toId: filmId } })).toBe(0);
});

it('stamps enrichedAt even when the lookup fails', async () => {
  // The same failure Plan 04's job shipped with: an unstamped row occupies the batch forever.
  fakeCatalog.shouldFail = true;
  await job.runOnce();
  expect((await prisma.title.findUniqueOrThrow({ where: { id: filmId } })).enrichedAt).not.toBeNull();
});

it('stops at the batch size', async () => {
  await seedTitles(ENRICH_BATCH_SIZE + 5);
  await job.runOnce();
  expect(fakeCatalog.structureCalls).toBe(ENRICH_BATCH_SIZE);
});

it('does nothing without a catalogue key', async () => {
  fakeCatalog.configured = false;
  await job.runOnce();
  expect(fakeCatalog.structureCalls).toBe(0);
});
```

Theme tests:

```ts
it('seeds a theme per label, scoped to the creator whose board the title is on', async () => {
  await themes.seedFor(titleId, creatorId, ['Animation', 'anime']);
  const rows = await prisma.theme.findMany({ where: { creatorId } });
  expect(rows.map((t) => t.name).sort()).toEqual(['Animation', 'anime']);
});

it('treats labels differing only in case as one theme', async () => {
  await themes.seedFor(titleId, creatorId, ['Anime', 'anime']);
  expect(await prisma.theme.count({ where: { creatorId } })).toBe(1);
});

it('does not resurrect a theme the creator renamed', async () => {
  // Re-seeding must not undo curation, which is the whole point of creator-scoped themes.
  await themes.seedFor(titleId, creatorId, ['Animation']);
  await prisma.theme.updateMany({ where: { creatorId }, data: { name: 'Cartoons', slug: 'cartoons' } });
  await themes.seedFor(otherTitleId, creatorId, ['Animation']);
  expect(await prisma.theme.count({ where: { creatorId } })).toBe(1);
});
```

The last one is why `sourceKey` exists: re-seeding matches on the TMDB label, not the display name.

- [ ] **Step 2: Run, watch fail, implement, commit**

---

## Task 4: Nesting and theme filtering on the board

**Files:**

- Modify: `apps/api/src/recommendations/recommendations.service.ts`, `apps/api/src/recommendations/dto/list-recommendations.query.ts`
- Test: `apps/api/test/board-nesting.int-spec.ts`

**Interfaces:**

- Board entries gain `parentId: string | null` and `themes: Array<{ id, name }>`.
- `GET /creators/:slug/recommendations?theme=<uuid>` narrows to entries carrying that theme.

- [ ] **Step 1: Write the failing test**

```ts
it('nests a season under its show when both are on the board', async () => {
  const res = await board(patron).expect(200);
  expect(entry(res, seasonId).parentId).toBe(showId);
});

it('leaves a season unnested when the show is not on the board', async () => {
  await remove(showId);
  const res = await board(patron).expect(200);
  expect(entry(res, seasonId).parentId).toBeNull();
});

it('does not nest under an entry the viewer cannot see', async () => {
  // Nesting must not leak the existence of a hidden entry.
  await reject(showId);
  const res = await board(patron).expect(200);
  expect(entry(res, seasonId).parentId).toBeNull();
});

it('nests a film under its franchise', async () => { ... });

it('picks the container, never the member, as the parent', async () => {
  // The relation is directional; nesting the show under its own season is the failure this
  // guards against.
  const res = await board(patron).expect(200);
  expect(entry(res, showId).parentId).toBeNull();
});

it('does not nest a RELATED pair', async () => {
  // "Similar" is not "contained by"; nesting on it would bury unrelated entries.
  expect(entry(res, similarId).parentId).toBeNull();
});

it('returns each entry themes', async () => { ... });

it('narrows the board to one theme', async () => {
  const res = await board(patron, `?theme=${themeId}`).expect(200);
  expect(res.body.items.every((i) => i.themes.some((t) => t.id === themeId))).toBe(true);
});

it('rejects a theme from another creator', async () => {
  await board(patron, `?theme=${otherCreatorThemeId}`).expect(404);
});

it('applies the same visibility rules with a theme filter', async () => {
  // The filter narrows the existing read model; it must not become a second place the
  // visibility rules live.
  await setHidePending(true);
  const res = await board(otherPatron, `?theme=${themeId}`).expect(200);
  expect(res.body.items.map((i) => i.id)).not.toContain(pendingId);
});
```

- [ ] **Step 2: Implement**

After the page is built, one query fetches relations whose `fromId` is in the page's title ids and
whose `toId` is also in the page's title ids, restricted to `SEASON_OF` and `SAME_FRANCHISE`. The
`parentId` is the recommendation carrying the `toId`.

- [ ] **Step 3: Run and commit**

---

## Task 5: Creator theme curation

**Files:**

- Create: `apps/api/src/intelligence/themes.controller.ts`, `apps/api/src/intelligence/dto/rename-theme.dto.ts`
- Test: `apps/api/test/themes.int-spec.ts`

**Interfaces:**

- `GET /creators/:slug/themes` (`VIEW`) → the creator's themes with entry counts.
- `PATCH /creators/:slug/themes/:id` (`MODERATE`) → `{ name }`.
- `DELETE /creators/:slug/themes/:id` (`MODERATE`) → removes it and its assignments.

- [ ] **Step 1: Write the failing test**

Asserts: listing returns themes with counts; renaming requires `MODERATE`; a rename that collides
with an existing theme's slug is a 409; a renamed theme keeps its assignments; a rename passes
moderation; deleting removes assignments but not titles; a theme from another creator 404s.

- [ ] **Step 2: Implement, run, commit**

---

## Task 6: The SPA

**Files:**

- Create: `apps/web/src/components/ThemeFilter.tsx`
- Modify: `apps/web/src/routes/CreatorBoard.tsx`, `apps/web/src/components/RecommendationCard.tsx`, `apps/web/src/api/hooks.ts`, `apps/web/src/api/types.ts`, `apps/web/src/test-support.tsx`
- Test: `apps/web/src/components/ThemeFilter.test.tsx`, `CreatorBoard.test.tsx` (extend)

- [ ] **Step 1: Write the failing tests**

Board: a child renders indented under its parent within the same column; a child whose parent is
absent renders at top level; the nesting is visible to a screen reader as a nested list, not by
margin alone; theme chips render on each card as text.

Filter: renders the creator's themes; selecting one refetches with `?theme=`; clearing restores the
full board; an empty theme list renders nothing rather than an empty control.

- [ ] **Step 2: Implement, run, commit**

---

## Task 7: End-to-end and verification

**Files:**

- Modify: `e2e/stub/patreon-stub.mjs` (structure routes), `e2e/tests/journey.spec.ts`, `README.md`

- [ ] **Step 1: Add the journeys**

1. A patron suggests a film and its collection; after enrichment the film renders nested under the
   franchise.
2. A patron filters the board by a theme and sees only entries carrying it.

- [ ] **Step 2: Full verification**

```bash
pnpm -r typecheck && pnpm -r test && pnpm format:check
docker-compose -f docker-compose.e2e.yml up -d --build && pnpm --filter e2e e2e
```

- [ ] **Step 3: Document relations and themes in the README, commit**

---

## Self-Review

**Spec coverage (design §5 catalog intelligence, §7 grouped views and creator admin):**

- `TitleRelation` with `SEASON_OF`/`SAME_FRANCHISE` from TMDB structure → Tasks 1–3. ✅
- "Submitting Season 2 of an existing show nests it under the existing entry/franchise" → Task 4. ✅
- `RELATED` from TMDB similar → Task 3. Partially: design §5 also wants embedding proximity, **deferred** with the embedding plan. ✅
- `Theme`/`TitleTheme` seeded from TMDB genres + keywords → Task 3. ✅
- "curatable by creators/mods" → Task 5 (rename, delete, assign); **merge deferred**. ✅
- "Enables nested/grouped board views" → Tasks 4, 6. ✅
- Embeddings, semantic de-dupe, personalised ranking, embedding-driven theme expansion → **deferred to a plan written once an embedding provider is chosen**, for the reason in Scope. ✅
- `SEQUEL`/`PREQUEL` → the enum carries them; nothing writes them. TMDB exposes no reliable sequel edge outside collection ordering, and inferring one from `ordinal` would be a guess. Stated, not pretended.

**Known risks:**

1. **Nesting only resolves within a page.** A child on page 1 whose parent is on page 2 renders at top level. Correct rather than wrong — it never nests under something absent — but a large board will show inconsistent nesting as it is paged. Fixing it properly means sorting parents and children adjacently, which fights the upvote ordering the board exists for.
2. **Enrichment is eventually consistent.** A title bound a moment ago has no relations until the job runs, so a submitter does not see their entry nest immediately. The same trade-off the availability plan made, for the same reason.
3. **Theme seeding copies a global fact into every creator's namespace.** A thousand creators with the same title means a thousand `Theme` rows. Intentional — it is what makes renaming possible without affecting anyone else — but it grows with creators × labels, not titles.
4. **TMDB's `similar` is weak.** It frequently returns loosely-connected titles, which is why `RELATED` deliberately does not drive nesting. It exists so the embedding plan has a column to improve rather than a table to create.
