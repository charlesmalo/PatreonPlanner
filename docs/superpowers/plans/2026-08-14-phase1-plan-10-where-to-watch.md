# Where-to-Watch Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, on every catalogue-bound card, where a patron can actually watch the thing — per region, from TMDB's watch-provider data, cached in Postgres with a TTL and refreshed in the background.

**Architecture:** An `AvailabilityProvider` interface mirroring the existing `CatalogProvider`, with a TMDB implementation behind it. `StreamingAvailability` rows are the cache of record — Redis fronts them for hot reads, but the durable copy is what survives a Redis flush and what the refresh job walks. The board's read model joins availability for the page it returns rather than the client fetching per card, because a board of twenty entries would otherwise mean twenty round trips.

**Tech Stack:** NestJS 10, Prisma 5.20, Postgres, BullMQ (all existing; no new dependencies).

## Global Constraints

- **A missing paid-provider key degrades, it does not break** (design §5): badges come from TMDB's free data, and deep links fall back to a search link. The app must boot and the board must render with no availability credential at all.
- **Region is explicit, never guessed from the request.** An availability answer is meaningless without the region it applies to.
- **TMDB's terms require attribution** on any surface showing their watch-provider data, and that data is sourced from JustWatch — the API docs require naming them. The UI must carry it.
- **Availability is a cache, not a source of truth.** Every row records when it was fetched; a stale row is still served while a refresh is queued, because a slightly old badge beats an empty card.
- **No `dangerouslySetInnerHTML`.** Provider names and logo paths come from a third party.
- **Generic errors to the caller, specific in the log** (design §9).

## Scope

**In scope:** the `AvailabilityProvider` interface, a TMDB implementation, the `StreamingAvailability` model with TTL semantics, availability on the board's read model and on `GET /catalog/titles/:id/availability`, a BullMQ refresh job, and the SPA badges.

**Out of scope — deliberately deferred, with the reason:**

- **A paid deep-link provider** (design §5) → needs a vendor, a contract and a key nobody has. The interface is shaped so one drops in, and the fallback (a search link on the provider's own site) is what ships.
- **Per-user region preference** → needs a profile surface. The region comes from a query parameter defaulting to a configured one, which is what the board needs to render.
- **Rent/buy pricing** → TMDB exposes the provider but not the price. Showing a provider without a price is honest; inventing one is not.
- **`TitleRelation` / themes / embeddings** (design §5 catalog intelligence) → their own plan, explicitly sequenced after the core loop.

## Decisions this plan settles

**Availability is stored per (title, region), not per title.** TMDB returns a map keyed by ISO-3166-1 country, and a row that flattened it would answer the wrong question for every patron outside the region it happened to be fetched for. The unique index is `(titleId, region)`.

**Stale-while-revalidate, not fetch-on-miss-and-block.** A read older than the TTL is returned as-is *and* enqueues a refresh. Blocking a board render on a third-party call means one slow upstream makes the whole board slow, and the freshness of a streaming badge is worth far less than the page loading.

**A title with no known providers stores a row, not nothing.** "We asked TMDB and it has nothing for this region" and "we have never asked" are different states, and without a row for the first the refresh job re-asks about every obscure title on every pass forever.

**Deep links degrade to a provider search URL.** TMDB gives a provider name and a logo, not a watch URL. Rather than link nowhere, each badge links to TMDB's own JustWatch-backed watch page for the title, which is the honest destination for the data we actually have.

**The board joins availability; it does not N+1.** `list()` already returns a page of entries with their titles. Availability for those titles is fetched in one query keyed by the page's title ids.

---

## Task 1: The provider interface and its TMDB implementation

**Files:**

- Create: `apps/api/src/availability/availability.provider.ts`, `apps/api/src/availability/availability.types.ts`, `apps/api/src/availability/tmdb-availability.provider.ts`
- Test: `apps/api/test/tmdb-availability.e2e-spec.ts`
- Modify: `apps/api/src/config/config.module.ts` (add `AVAILABILITY_REGION_DEFAULT`)

**Interfaces:**

- Produces:

```ts
export interface AvailabilityOffer {
  providerId: number;
  providerName: string;
  logoPath: string | null;
  /** How the title is available: TMDB's flatrate/free/ads/rent/buy. */
  kind: 'FLATRATE' | 'FREE' | 'ADS' | 'RENT' | 'BUY';
  displayPriority: number;
}

export interface AvailabilitySnapshot {
  region: string;
  /** TMDB's own watch page for this title and region; null when it gives none. */
  link: string | null;
  offers: AvailabilityOffer[];
}

export const AVAILABILITY_PROVIDER = Symbol('AVAILABILITY_PROVIDER');

export interface AvailabilityProvider {
  isConfigured(): boolean;
  fetch(tmdbId: number, mediaType: MediaType, region: string): Promise<AvailabilitySnapshot | null>;
}
```

- [ ] **Step 1: Write the failing test**

The provider is tested against a stubbed `fetch`, like `patreon-client.e2e-spec.ts` does — no network.

```ts
it('maps TMDB watch providers for the requested region', async () => {
  global.fetch = stubJson({
    id: 129,
    results: {
      GB: {
        link: 'https://www.themoviedb.org/movie/129/watch?locale=GB',
        flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/n.jpg', display_priority: 1 }],
        rent: [{ provider_id: 3, provider_name: 'Google Play', logo_path: '/g.jpg', display_priority: 5 }],
      },
      US: { link: 'https://example.invalid/us', flatrate: [] },
    },
  });
  const snapshot = await provider.fetch(129, 'MOVIE', 'GB');
  expect(snapshot?.offers).toEqual([
    { providerId: 8, providerName: 'Netflix', logoPath: '/n.jpg', kind: 'FLATRATE', displayPriority: 1 },
    { providerId: 3, providerName: 'Google Play', logoPath: '/g.jpg', kind: 'RENT', displayPriority: 5 },
  ]);
  expect(snapshot?.link).toBe('https://www.themoviedb.org/movie/129/watch?locale=GB');
});

it('returns an empty snapshot rather than null when the region is absent', async () => {
  // "TMDB knows nothing here" is a real answer and must be cacheable; null would mean "we never
  // asked" and the refresh job would re-ask forever.
  global.fetch = stubJson({ id: 129, results: { US: { link: 'x', flatrate: [] } } });
  const snapshot = await provider.fetch(129, 'MOVIE', 'GB');
  expect(snapshot).toEqual({ region: 'GB', link: null, offers: [] });
});

it('returns null for a title TMDB does not know', async () => {
  global.fetch = stubStatus(404);
  expect(await provider.fetch(999, 'MOVIE', 'GB')).toBeNull();
});

it('reports not configured without an API key', () => {
  expect(unconfiguredProvider.isConfigured()).toBe(false);
});

it('never logs the response body', async () => {
  // The body can echo the key on some TMDB errors, exactly as the catalogue provider documents.
  global.fetch = stubStatus(401);
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  await expect(provider.fetch(1, 'MOVIE', 'GB')).rejects.toThrow();
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^TMDB availability request failed with status 401$/));
});

it('uses the tv path for a series', async () => {
  const calls: string[] = [];
  global.fetch = recordUrl(calls, { id: 1, results: {} });
  await provider.fetch(1, 'TV', 'GB');
  expect(calls[0]).toContain('/tv/1/watch/providers');
});
```

Note the 404-vs-error distinction: TMDB answers 404 for an unknown id and 401/5xx for trouble. The
first is a client mistake and returns `null`; the second must throw so the caller does not cache an
"unavailable everywhere" answer produced by an outage.

- [ ] **Step 2: Run it, watch it fail**

- [ ] **Step 3: Implement**

Endpoint is `/movie/{id}/watch/providers` or `/tv/{id}/watch/providers`. The five arrays TMDB may
return per region map to the five `kind` values; iterate them in the order
`flatrate, free, ads, rent, buy` so the cheapest way to watch sorts first.

- [ ] **Step 4: Add `AVAILABILITY_REGION_DEFAULT` to the config schema**

A two-letter ISO-3166-1 code, defaulting to `US`, validated by the same Zod schema as every other
setting.

- [ ] **Step 5: Run and commit**

---

## Task 2: The StreamingAvailability model

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260814000000_streaming_availability/migration.sql`

**Interfaces:**

- Produces: model `StreamingAvailability`, enum `OfferKind`.

- [ ] **Step 1: Add the model**

```prisma
enum OfferKind {
  FLATRATE
  FREE
  ADS
  RENT
  BUY
}

model StreamingAvailability {
  id        String    @id @default(uuid()) @db.Uuid
  titleId   String    @db.Uuid
  // ISO-3166-1 alpha-2. An availability answer without its region answers the wrong question
  // for every patron outside it.
  region    String    @db.VarChar(2)
  // TMDB's watch page for this title and region. Null when it offers none.
  link      String?
  // Denormalized offers: read whole, never queried by field, and the shape is the provider's.
  offers    Json
  // When the upstream was last asked — not when the row changed. Staleness is about the
  // question, not the answer, so an unchanged refresh still moves it forward.
  fetchedAt DateTime  @default(now())
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  title Title @relation(fields: [titleId], references: [id], onDelete: Cascade)

  @@unique([titleId, region])
  // The refresh job walks the oldest first, across all titles.
  @@index([fetchedAt])
}
```

Add `availability StreamingAvailability[]` to `Title`.

- [ ] **Step 2: Write the migration by hand**

The repo's established practice — `schema.prisma` carries deliberate drift from earlier partial
indexes, so `migrate dev` cannot be used to generate it. Follow
`20260813000000_moderation_lifecycle/migration.sql` for the shape.

- [ ] **Step 3: Apply with `migrate deploy`, then `migrate reset --force` to prove it replays**

- [ ] **Step 4: Commit**

---

## Task 3: The availability service

**Files:**

- Create: `apps/api/src/availability/availability.service.ts`, `apps/api/src/availability/availability.module.ts`
- Test: `apps/api/test/availability.int-spec.ts`

**Interfaces:**

- Produces:
  - `AvailabilityService.forTitles(titleIds: string[], region: string): Promise<Map<string, StoredAvailability>>`
  - `AvailabilityService.forTitle(titleId: string, region: string): Promise<StoredAvailability | null>`
  - `AvailabilityService.refresh(titleId: string, region: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
it('fetches and stores availability the first time it is asked', async () => {
  const stored = await service.forTitle(titleId, 'GB');
  expect(stored?.offers[0].providerName).toBe('Netflix');
  const row = await prisma.streamingAvailability.findUniqueOrThrow({
    where: { titleId_region: { titleId, region: 'GB' } },
  });
  expect(row.region).toBe('GB');
});

it('serves a fresh row without calling the provider again', async () => {
  await service.forTitle(titleId, 'GB');
  fakeProvider.calls = 0;
  await service.forTitle(titleId, 'GB');
  expect(fakeProvider.calls).toBe(0);
});

it('serves a stale row immediately and refreshes behind it', async () => {
  // A slow upstream must not make the board slow; a slightly old badge is worth more than a
  // blocked render.
  await service.forTitle(titleId, 'GB');
  await makeStale(titleId, 'GB');
  fakeProvider.nextName = 'Prime Video';
  const stored = await service.forTitle(titleId, 'GB');
  expect(stored?.offers[0].providerName).toBe('Netflix'); // the stale answer, served now
  await service.drainRefreshes();
  const row = await prisma.streamingAvailability.findUniqueOrThrow({ ... });
  expect((row.offers as Offer[])[0].providerName).toBe('Prime Video');
});

it('stores a row when the provider knows nothing, so the question is not re-asked', async () => {
  fakeProvider.nextSnapshot = { region: 'GB', link: null, offers: [] };
  await service.forTitle(otherTitleId, 'GB');
  const row = await prisma.streamingAvailability.findUniqueOrThrow({ ... });
  expect(row.offers).toEqual([]);
});

it('keeps regions apart', async () => {
  await service.forTitle(titleId, 'GB');
  fakeProvider.nextName = 'Hulu';
  const us = await service.forTitle(titleId, 'US');
  expect(us?.offers[0].providerName).toBe('Hulu');
  const gb = await service.forTitle(titleId, 'GB');
  expect(gb?.offers[0].providerName).toBe('Netflix');
});

it('returns null rather than throwing when the provider is not configured', async () => {
  // Design §5: badges are optional garnish. A missing key must not fail a board render.
  expect(await unconfiguredService.forTitle(titleId, 'GB')).toBeNull();
});

it('returns null rather than throwing when the provider errors', async () => {
  fakeProvider.throwNext = true;
  expect(await service.forTitle(titleId, 'GB')).toBeNull();
  // And stores nothing: an outage must not be cached as "available nowhere".
  expect(await prisma.streamingAvailability.count({ where: { titleId } })).toBe(0);
});

it('reads a page of titles in one query', async () => {
  const map = await service.forTitles([titleId, otherTitleId], 'GB');
  expect(map.size).toBe(2);
});

it('rejects a malformed region rather than storing it', async () => {
  await expect(service.forTitle(titleId, 'not-a-region')).rejects.toThrow();
});
```

- [ ] **Step 2: Run, watch fail, implement**

`forTitles` is the board's path: it reads the stored rows for the whole page in one query, returns
what it has, and enqueues refreshes for the missing and the stale. It never blocks on the provider —
a card without a badge is fine, a board that waits on a third party is not.

`forTitle` is the single-title path used by the endpoint, and *does* fetch synchronously on a
complete miss, because a client that asked specifically for availability wants an answer.

- [ ] **Step 3: Run and commit**

---

## Task 4: Endpoint and board integration

**Files:**

- Create: `apps/api/src/availability/availability.controller.ts`, `apps/api/src/availability/dto/availability.query.ts`
- Modify: `apps/api/src/recommendations/recommendations.service.ts`, `apps/api/src/catalog/catalog.module.ts`
- Test: `apps/api/test/availability-board.int-spec.ts`

**Interfaces:**

- Produces: `GET /catalog/titles/:id/availability?region=GB`; board entries gain
  `availability: { region, link, offers } | null`.

- [ ] **Step 1: Write the failing test**

```ts
it('returns availability for a catalogue title', async () => {
  const res = await patron.get(`/catalog/titles/${titleId}/availability?region=GB`).expect(200);
  expect(res.body.offers[0].providerName).toBe('Netflix');
});

it('defaults to the configured region', async () => {
  const res = await patron.get(`/catalog/titles/${titleId}/availability`).expect(200);
  expect(res.body.region).toBe('US');
});

it('rejects a malformed region', async () => {
  await patron.get(`/catalog/titles/${titleId}/availability?region=GBR`).expect(400);
});

it('404s an unknown title', async () => {
  await patron.get(`/catalog/titles/${randomUUID()}/availability`).expect(404);
});

it('attaches availability to board entries bound to a title', async () => {
  const res = await patron.get(`/creators/${slug}/recommendations`).expect(200);
  const bound = res.body.items.find((i) => i.title !== null);
  expect(bound.availability.offers[0].providerName).toBe('Netflix');
});

it('leaves external-link entries with null availability', async () => {
  // Nothing to look up: an external link has no canonical identity.
  const res = await patron.get(`/creators/${slug}/recommendations`).expect(200);
  const unbound = res.body.items.find((i) => i.title === null);
  expect(unbound.availability).toBeNull();
});

it('renders the board when availability is unavailable', async () => {
  // The whole point of degrading: no key, no badges, still a board.
  const res = await unconfigured.get(`/creators/${slug}/recommendations`).expect(200);
  expect(res.body.items.length).toBeGreaterThan(0);
  expect(res.body.items[0].availability).toBeNull();
});
```

The endpoint requires no capability — the catalogue is global, not per-creator, and `catalog/search`
already sits outside the tenant guard. It does require a session, matching search.

- [ ] **Step 2: Run, watch fail, implement**

In `list()`, after the page is built, collect the non-null `titleId`s and call `forTitles` once.

- [ ] **Step 3: Run and commit**

---

## Task 5: The refresh job

**Files:**

- Create: `apps/api/src/jobs/availability-refresh.job.ts`
- Modify: `apps/api/src/jobs/jobs.module.ts`
- Test: `apps/api/test/availability-refresh.int-spec.ts`

**Interfaces:**

- Produces: a BullMQ repeatable job refreshing the oldest availability rows.

- [ ] **Step 1: Write the failing test**

```ts
it('refreshes the oldest rows first and stops at the batch size', async () => {
  // The staleness job in Plan 04 shipped without a SQL LIMIT; this asserts the query has one.
  await seedRows(10, { stale: true });
  await job.run();
  expect(fakeProvider.calls).toBe(BATCH_SIZE);
});

it('leaves fresh rows alone', async () => {
  await seedRows(3, { stale: false });
  await job.run();
  expect(fakeProvider.calls).toBe(0);
});

it('moves fetchedAt forward even when nothing changed', async () => {
  // Otherwise an unchanging title is retried on every pass and starves the queue.
  const before = await seedRow({ stale: true });
  await job.run();
  const after = await prisma.streamingAvailability.findUniqueOrThrow({ where: { id: before.id } });
  expect(after.fetchedAt.getTime()).toBeGreaterThan(before.fetchedAt.getTime());
});

it('keeps going when one title fails', async () => {
  await seedRows(3, { stale: true });
  fakeProvider.failOn = 2;
  await job.run();
  expect(fakeProvider.calls).toBe(3);
});

it('does nothing when the provider is not configured', async () => {
  await seedRows(3, { stale: true });
  await unconfiguredJob.run();
  expect(fakeProvider.calls).toBe(0);
});
```

- [ ] **Step 2: Run, watch fail, implement**

Select with an explicit `take`, ordered by `fetchedAt` ascending, and stamp `fetchedAt` on every
attempt — success or failure — so a permanently failing title cannot occupy the batch forever. This
is the exact failure Plan 04's membership job shipped with and had to be fixed for.

- [ ] **Step 3: Run and commit**

---

## Task 6: The SPA badges

**Files:**

- Create: `apps/web/src/components/AvailabilityBadges.tsx`
- Modify: `apps/web/src/components/RecommendationCard.tsx`, `apps/web/src/api/types.ts`, `apps/web/src/test-support.tsx`
- Test: `apps/web/src/components/AvailabilityBadges.test.tsx`

- [ ] **Step 1: Write the failing test**

Asserts: nothing renders when `availability` is null or has no offers (an empty row is not an empty
badge strip); flatrate offers render before rent and buy; each badge names the provider as text and
carries the logo with an `alt`; the "watch" link carries `rel="noopener noreferrer"` and
`target="_blank"`; a null `link` renders the provider names without a link rather than a dead one;
the JustWatch attribution TMDB's terms require is present whenever any badge is; a provider name
containing markup renders as text.

- [ ] **Step 2: Implement, then run and commit**

---

## Task 7: End-to-end and verification

**Files:**

- Modify: `e2e/stub/patreon-stub.mjs` (watch-providers route), `e2e/tests/journey.spec.ts`, `README.md`

- [ ] **Step 1: Add the stub route and the journey**

The stub already stands in for TMDB search and title lookup; add `/movie/:id/watch/providers`. The
journey: a patron suggests a catalogue title and sees a "Netflix" badge on the resulting card.

- [ ] **Step 2: Full verification**

```bash
pnpm -r typecheck && pnpm -r test && pnpm format:check
docker-compose -f docker-compose.e2e.yml up -d --build && pnpm --filter e2e e2e
```

- [ ] **Step 3: Document the region setting and the attribution requirement in the README, commit**

---

## Self-Review

**Spec coverage (design §5 "Where-to-watch"):**

- `AvailabilityProvider` behind an interface → Task 1. ✅
- TMDB Watch Providers, free baseline badges, per region → Tasks 1, 3. ✅
- Cached in `StreamingAvailability` with TTL background refresh → Tasks 2, 3, 5. ✅
- "If the paid key is absent, badges still work, deep links degrade to a search link" → Tasks 1, 3, 6; the paid provider itself is deferred, and the fallback is what ships. ✅
- Where-to-watch badges/deep-links on board cards (design §7) → Tasks 4, 6. ✅
- Redis hot cache for availability (design §5 caching) → **not built**: `StreamingAvailability` is already a durable cache read by primary key, and fronting a single indexed Postgres read with Redis is machinery without a measured problem. Noted as a risk rather than pretended.

## Found in review (fixed)

1. **Critical — background refreshes were unbounded and undeduplicated.** `queueRefresh` started
   work without consulting anything: a cold board of twenty entries fired twenty simultaneous
   upstream calls, and ten readers of that same board fired two hundred for twenty distinct keys.
   Now de-duplicated by `titleId:region` through a shared in-flight promise and capped at
   `MAX_IN_FLIGHT_REFRESHES`; anything over the cap is left to the refresh job, which is the
   durable path anyway.
2. **Critical — a title the upstream did not know was re-asked on every board read, forever.**
   Exactly the failure this plan's own decision section forbids: the empty-region case stored a
   row, but the 404 case stored nothing, so "never asked" and "asked, nothing there" were
   indistinguishable and the second kept re-queueing. Both now store a row.
3. **Important — a board read was not isolated from availability failing.** Only the
   *unconfigured* path degraded; a runtime failure propagated and would have 500'd the whole
   board. Now caught and logged, badges dropped.
4. **Important — `drainRefreshes` was documented as the shutdown hook but never wired**, and its
   `while (size > 0)` could not terminate under sustained traffic. `AvailabilityService` now
   implements `OnApplicationShutdown`, sets a `stopping` flag that blocks new queueing, and the
   drain is bounded.
5. **Important — the endpoint was unreachable.** It keys on `Title.id`, which no response
   exposed: `list()` selected `titleId` for the join and deliberately dropped it, and
   `catalog/search` returns `tmdbId`. The endpoint and its tests both worked only because the
   tests read the id straight from Prisma. The board's title projection now includes `id`.
6. **Important — the region was a free parameter on a `VIEW`-gated route.** One caller could
   drive 676 upstream lookups for a single title and leave 676 rows in the refresh job's working
   set permanently. Bounded by `AVAILABILITY_REGIONS`.
7. **Minor, also fixed:** the third-party watch URL became an `href` without the `isSafeHttpUrl`
   guard the cards one file over already apply; the board spec could leak a queued refresh across
   tests; `.env.example` was missing the new settings.

**Known risks:**

0. **A row whose region is later removed from `AVAILABILITY_REGIONS` throws on every refresh
   attempt.** The job stamps `fetchedAt` regardless, so it is retried once per TTL rather than
   spinning — bounded, but it is dead work that a cleanup pass should remove.
1. **`forTitles` never blocks, so a cold board shows no badges on first load.** The refresh lands and the next render has them. Correct for the common case — a board is read far more often than it is first read — but a creator opening a brand-new board sees an unadorned page and may conclude the feature is broken.
2. **The refresh job walks every region ever asked for.** Ten regions across a thousand titles is ten thousand rows on a fixed batch size, and the oldest-first ordering means an unpopular region can be refreshed as eagerly as the busy one. A popularity signal belongs here eventually.
3. **TMDB's provider data is JustWatch's, and its licence terms are stricter than TMDB's own.** The attribution is implemented; whether the deployment's usage stays inside JustWatch's terms is a question for whoever ships it, not something code settles.
4. **No negative caching for provider errors.** An outage means every board read for a stale title re-enqueues a refresh that fails. The job's `fetchedAt` stamp bounds it, but a circuit breaker would bound it better.
