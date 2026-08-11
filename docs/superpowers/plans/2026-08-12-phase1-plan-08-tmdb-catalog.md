# TMDB Catalog & Mainstream Submissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a patron search for a real film or show and suggest it as a canonical title, so two people suggesting "Spirited Away" land on the same board entry regardless of how they typed it.

**Architecture:** TMDB sits behind a `CatalogProvider` interface, exactly as design §5 specifies, with an HTTP implementation and a fake. Searches are cached in Redis and every title ever searched or submitted is persisted as a local `Title` — design §5's "local catalog as cache", so repeat lookups never re-hit TMDB. A submission may now bind a `titleId`; de-duplication becomes canonical for those and stays normalized-title for `EXTERNAL_LINK`.

**Tech Stack:** NestJS 10, Prisma, Redis, native `fetch`, Jest + supertest + Testcontainers, Playwright.

## Global Constraints

Carried forward from design §9.

- **`class-validator` DTOs on every endpoint.**
- **Generic errors**; no upstream response bodies surfaced, no secrets logged.
- **All authorization server-side**; catalog search is gated by the same capability model.
- **CSRF** on state-changing routes.
- **Local catalog as cache** (design §5) — a searched title is persisted, so TMDB is asked once.

## Scope

**In scope:** `Title` and `TitleAlias` models, `CatalogProvider` + TMDB implementation + fake, Redis-cached search, `GET /creators/:slug/catalog/search`, `MOVIE`/`SHOW` submissions bound to a canonical `Title`, canonical de-duplication, title metadata on the board, and SPA search-and-pick in the submit form.

**Out of scope — deliberately deferred:**

- **Where-to-watch** (`AvailabilityProvider`, `StreamingAvailability`, TTL refresh) → next plan. It is a second provider with its own cache and refresh job, and the board is useful without badges.
- **`FRANCHISE` / `WATCH_ORDER`** → next plan. Both need TMDB collections and ordered `WatchOrderItem`s; `MOVIE` and `SHOW` are the classes that make the catalog useful on their own.
- **`TitleRelation`, themes, embeddings** → the catalog-intelligence plan, which design §5 sequences after the core loop.
- **`TitleAlias` population from TMDB translations** — the model lands here so the catalog-intelligence plan has somewhere to write, but only the primary title is stored today.

## Prerequisites

Plans 01–07 merged. In particular `CreatorAccessGuard`, the recommendations loop, and the E2E harness — which is how this plan's SPA changes get verified against the real API rather than a fake.

**No TMDB key is required to build or test this.** Every test runs against `FakeCatalogProvider`; the E2E stack extends the existing stub. A key is needed only to talk to the real TMDB.

## Decisions this plan settles

**A missing `TMDB_API_KEY` degrades rather than crashes.** Search answers `503` with a generic message and mainstream submissions are refused; `EXTERNAL_LINK` keeps working. Making the key required would mean no developer, and no CI run, could boot the API without a third-party credential — and design §5 already treats external links as a first-class class, not a fallback.

**Canonical de-duplication is a partial unique index, not application logic.** Design §5 specifies `unique(creatorId, titleId, type)`. Plan 05 learned that a read-then-write check loses the race, so this is enforced in Postgres: one partial index for TMDB-bound rows and one for `EXTERNAL_LINK` rows keyed on `normalizedTitle`. Prisma cannot express partial uniques, so the migration is hand-written — the same route Plan 05 took.

**A search result is persisted on submit, not on search.** Writing a `Title` for every autocomplete keystroke would fill the table with things nobody suggested. The row is created when a submission binds to it, which is also the first moment we need it to exist.

**TMDB's base URL is configurable.** Same reasoning as Patreon in Plan 07: the E2E suite drives a stub, and hardcoding the host would make a genuine browser test impossible.

---

## Task 1: `Title`, `TitleAlias`, and canonical de-duplication

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: migration (hand-written for the partial uniques)
- Test: `apps/api/test/title-model.int-spec.ts`

**Interfaces:**

- Produces: enums `MediaType { MOVIE, TV }`, `AliasKind { OFFICIAL, ROMAJI, NATIVE, ALTERNATIVE }`; models `Title`, `TitleAlias`; `Recommendation.titleId`.

- [ ] **Step 1: Add the models**

```prisma
enum MediaType {
  MOVIE
  TV
}

enum AliasKind {
  OFFICIAL
  ROMAJI
  NATIVE
  ALTERNATIVE
}

model Title {
  id         String    @id @default(uuid()) @db.Uuid
  tmdbId     Int
  mediaType  MediaType
  name       String
  year       Int?
  posterPath String?
  overview   String?
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt

  aliases         TitleAlias[]
  recommendations Recommendation[]

  // TMDB ids are only unique within a media type: film 123 and series 123 are different works.
  @@unique([tmdbId, mediaType])
}

model TitleAlias {
  id        String    @id @default(uuid()) @db.Uuid
  titleId   String    @db.Uuid
  language  String
  kind      AliasKind
  text      String
  createdAt DateTime  @default(now())

  title Title @relation(fields: [titleId], references: [id], onDelete: Cascade)

  @@unique([titleId, language, kind, text])
  @@index([titleId])
}
```

On `Recommendation`, add `titleId String? @db.Uuid`, the relation, and `@@index([titleId])`. `RecommendationType` already has `MOVIE`/`SHOW`.

- [ ] **Step 2: Hand-write the migration for the partial uniques**

Prisma generates the tables; the two partial indexes are added by hand, replacing the unconditional `Recommendation_creatorId_normalizedTitle_key` from Plan 05:

```sql
DROP INDEX "Recommendation_creatorId_normalizedTitle_key";

-- Canonical de-duplication (design §5). Partial, because it only applies to TMDB-bound rows.
CREATE UNIQUE INDEX "Recommendation_creatorId_titleId_type_key"
  ON "Recommendation"("creatorId", "titleId", "type")
  WHERE "titleId" IS NOT NULL AND "status" <> 'DELETED';

-- External links have no canonical id, so they keep de-duplicating on the normalized title.
CREATE UNIQUE INDEX "Recommendation_creatorId_normalizedTitle_key"
  ON "Recommendation"("creatorId", "normalizedTitle")
  WHERE "titleId" IS NULL AND "status" <> 'DELETED';
```

Excluding `DELETED` is new and deliberate: Plan 05's index blocked resubmitting anything a moderator had removed, permanently.

- [ ] **Step 3: Model test**

Assert: `(tmdbId, mediaType)` is unique but the same `tmdbId` may exist as both `MOVIE` and `TV`; two creators may each bind the same title; one creator cannot bind the same title twice with the same type; the same title with a *different* type is allowed; a soft-deleted row does not block a resubmission; aliases cascade with their title.

- [ ] **Step 4: Run and commit**

---

## Task 2: `CatalogProvider` and the TMDB client

**Files:**

- Create: `apps/api/src/catalog/catalog.types.ts`, `catalog.provider.ts`, `tmdb-catalog.provider.ts`, `catalog.module.ts`
- Create: `apps/api/test/support/fake-catalog.provider.ts`
- Modify: `apps/api/src/config/config.schema.ts`
- Test: `apps/api/test/tmdb-catalog.e2e-spec.ts`

**Interfaces:**

- Produces: `CATALOG_PROVIDER` token; `interface CatalogProvider { search(query: string): Promise<CatalogResult[]>; fetchTitle(tmdbId: number, mediaType: MediaType): Promise<CatalogResult | null> }`; `CatalogResult { tmdbId, mediaType, name, year, posterPath, overview }`. New config: `TMDB_API_KEY` (optional), `TMDB_API_BASE_URL` (default `https://api.themoviedb.org/3`).

- [ ] **Step 1: Config**

```ts
  // Optional: without it, mainstream search and submissions are refused while EXTERNAL_LINK
  // keeps working. Requiring it would mean no developer and no CI run could boot the API.
  TMDB_API_KEY: z.string().min(1).optional(),
  TMDB_API_BASE_URL: z.string().url().default('https://api.themoviedb.org/3'),
```

- [ ] **Step 2: Failing test**

`tmdb-catalog.e2e-spec.ts` with a stubbed `fetch` asserts: multi-search results are mapped to `CatalogResult` with `movie`→`MOVIE` and `tv`→`TV`; `person` results are dropped; the release year is parsed from `release_date`/`first_air_date` and is null when absent or malformed; a missing key makes `isConfigured` false and `search` throw a configuration error; a non-200 throws without leaking the body; the API key is sent as a bearer token and never appears in a thrown message.

- [ ] **Step 3: Implement**

`TmdbCatalogProvider` calls `/search/multi` and `/movie/:id` / `/tv/:id`, maps results, and exposes `isConfigured`. `title.name` comes from `title` for films and `name` for series — TMDB uses different fields per media type, and picking the wrong one yields undefined names for half the catalog.

- [ ] **Step 4: The fake**

`FakeCatalogProvider` with settable `results` and a `searchCalls` log so caching can be asserted by call count.

- [ ] **Step 5: Run and commit**

---

## Task 3: Cached search endpoint

**Files:**

- Create: `apps/api/src/catalog/catalog.service.ts`, `catalog.controller.ts`, `dto/search-catalog.query.ts`
- Test: `apps/api/test/catalog-search.int-spec.ts`

**Interfaces:**

- Produces: `GET /api/v1/creators/:slug/catalog/search?q=` (`SUBMIT`) → `{ results: CatalogResult[] }`.

Gated on `SUBMIT` rather than `VIEW`: the endpoint exists to feed the submit form, and it spends a third-party quota. Anyone who cannot submit has no reason to consume it.

- [ ] **Step 1: Failing test**

Asserts: 403 for a viewer who cannot submit; results returned for one who can; a second identical search does not call TMDB again (cache hit, asserted via `searchCalls`); different queries are cached separately; a blank or one-character query is rejected `400` without calling TMDB; a provider failure yields `502`, not `500`; with no key configured the endpoint answers `503`.

- [ ] **Step 2: Implement**

Cache key `catalog:search:<normalized query>`, TTL 24h. The query is normalized and length-bounded before it becomes a cache key, so a caller cannot fill Redis with unbounded distinct keys.

- [ ] **Step 3: Run and commit**

---

## Task 4: Mainstream submissions

**Files:**

- Modify: `apps/api/src/recommendations/recommendations.service.ts`, `dto/submit-recommendation.dto.ts`
- Test: `apps/api/test/recommendations.int-spec.ts` (extend)

**Interfaces:**

- Produces: `POST .../recommendations` additionally accepts `{ type: 'MOVIE' | 'SHOW', tmdbId: number }`, resolving and persisting a `Title` and binding it.

- [ ] **Step 1: DTO**

`type` widens to `MOVIE | SHOW | EXTERNAL_LINK`. `tmdbId` is required when the type is mainstream and forbidden otherwise; `customTitle` becomes optional for mainstream, since the canonical name comes from TMDB. Cross-field rules use `@ValidateIf`, so a `MOVIE` with no `tmdbId` is a 400 rather than a row nothing can resolve.

- [ ] **Step 2: Failing test**

Asserts: a `MOVIE` with a valid `tmdbId` creates a `Title` and binds it; the stored `customTitle` is TMDB's name, not anything the client sent; a second submission of the same `tmdbId` reuses the existing `Title` rather than creating a duplicate; a second submission by *another* patron returns `duplicate: true` with the same entry; the same `tmdbId` may be submitted to a *different* creator; a `tmdbId` TMDB does not know yields `400` and writes nothing; `MOVIE` without `tmdbId` is `400`; `EXTERNAL_LINK` with a `tmdbId` is `400`; and moderation still runs on the description.

- [ ] **Step 3: Implement**

Resolution order: validate → rate limit → moderation → resolve title (upsert `Title` from the provider) → canonical de-dupe → persist. Title resolution sits after moderation for the same reason de-dupe does: a blocked submission must not be able to probe the catalog or spend quota.

The P2002 fallback from Plan 05 now has to distinguish which index fired, so a canonical collision resolves to the existing entry and a genuine constraint bug still surfaces.

- [ ] **Step 4: Run and commit**

---

## Task 5: Title metadata on the board

**Files:**

- Modify: `apps/api/src/recommendations/recommendations.service.ts`
- Modify: `apps/web/src/api/types.ts`, `components/RecommendationCard.tsx`
- Test: extend API and web suites

**Interfaces:**

- Produces: board items gain `title: { tmdbId, mediaType, name, year, posterPath } | null`.

- [ ] **Step 1: Failing tests**

API: a bound entry returns its title block; an `EXTERNAL_LINK` entry returns `null`; the block never includes internal ids.

Web: a card with a title renders the poster and year; a card without one renders as before; the poster `img` has meaningful `alt` text; a null `posterPath` renders no broken image.

- [ ] **Step 2: Implement**

Poster URLs are built from TMDB's image CDN base in the SPA rather than stored, so the size can change without a migration. The `img` carries `loading="lazy"` and explicit dimensions to avoid layout shift.

- [ ] **Step 3: Run and commit**

---

## Task 6: Search-and-pick in the submit form, and verification

**Files:**

- Modify: `apps/web/src/components/SubmitForm.tsx`, `src/api/client.ts`
- Modify: `e2e/stub/patreon-stub.mjs` → add TMDB routes, `docker-compose.e2e.yml`
- Test: `apps/web/src/components/SubmitForm.test.tsx`, `e2e/tests/journey.spec.ts`

- [ ] **Step 1: Failing web tests**

Asserts: typing in the search field queries after a debounce, not per keystroke; results are listed as buttons with accessible names; picking one binds the `tmdbId` and shows the chosen title; the submit posts `{ type, tmdbId }` and no `customTitle`; clearing the choice returns to the free-text external-link mode; a failed search shows a message and still allows an external-link submission.

- [ ] **Step 2: Implement**

The form has two modes — pick a known title, or describe an external link — with the mainstream path preferred and the external path always reachable, matching design §5's "no match → prompt to refine or switch to `EXTERNAL_LINK`".

- [ ] **Step 3: Extend the E2E stub and suite**

The stub gains `/3/search/multi` and `/3/{movie,tv}/:id`; the compose file points `TMDB_API_BASE_URL` at it and sets a dummy key. The journey test gains: search for a title, pick it, submit, see it on the board with its year — and a second patron submitting the same title is told it is already there.

- [ ] **Step 4: Full verification**

```bash
pnpm -r typecheck && pnpm -r test && pnpm format:check
pnpm --filter @app/e2e stack:up && pnpm --filter @app/e2e e2e
```

- [ ] **Step 5: Document and commit**

---

## Self-Review

**Spec coverage (design §5 catalog, content classes, submit flow, de-dupe, caching):**

- `Title` / `TitleAlias` models → Task 1. ✅
- `CatalogProvider` behind an interface with a fake → Task 2 (design §10 asks for exactly this). ✅
- `catalog/search` autocomplete, cached → Task 3. ✅
- TMDB confirmation before binding a canonical title → Task 4. ✅
- Canonical de-dupe `unique(creatorId, titleId, type)` → Task 1, enforced in Postgres. ✅
- "No match → switch to `EXTERNAL_LINK`" → Task 6's two-mode form. ✅
- Local catalog as cache; Redis hot cache for search → Tasks 3-4. ✅
- `FRANCHISE`/`WATCH_ORDER`, availability, aliases from translations, relations, themes, embeddings → **deferred** with the plan each belongs to. ✅

**Type consistency:** `CatalogResult` is defined in Task 2 and consumed in Tasks 3–5. `MediaType` comes from Prisma and is reused rather than redeclared. `CATALOG_PROVIDER` follows the `PATREON_CLIENT` pattern from Plan 02. Board `title` block shape is defined in Task 5 and mirrored in the SPA's `types.ts`. ✅

**Known risks:**

1. **The partial unique on `status <> 'DELETED'` changes Plan 05 behaviour.** Previously a soft-deleted entry blocked resubmission forever; now it does not. That is the better behaviour, but it is a behaviour change and the model test pins it.
2. **Ambiguous search results are not disambiguated server-side.** Design §5 wants candidates returned for the user to pick — which is what the form does — but nothing prevents a client binding a `tmdbId` the user never saw. Harmless: the id is validated against TMDB before it is stored.
3. **Search spends third-party quota per unique query.** The 24h cache and the `SUBMIT` gate bound it; a per-user rate limit on search belongs with the abuse-control plan.
