# PatreonPlanner — Phase 1 Design (Core Web App)

- **Status:** Draft for review
- **Date:** 2026-08-03
- **Scope:** Phase 1 only — the core web application. Later phases (discussions, Discord bot, browser extension) are noted as forward-compatible hooks, not designed here.

---

## 1. Overview & Product Vision

PatreonPlanner is a **multi-tenant** web platform where Patreon creators host a
Recommendations/Planner board. Patrons log in via Patreon and submit recommendations
(shows, movies, franchises, watch-orders, or external/fandom links), search whether an
idea already exists, and upvote it. Creators and their verified moderators triage
submissions through a lifecycle (pending → accepted → active → completed), annotate them
with notes/timelines, and moderate abuse.

The full product spans several subsystems delivered in phases:

| Phase | Scope |
|---|---|
| **1 (this doc)** | Core web app: Patreon auth + roles, submit/search/upvote, catalog intelligence, abuse control + moderation, creator/mod board |
| 2 | Per-entry discussion threads |
| 3 | Discord bot (submit/upvote/browse + Patreon↔Discord linking) |
| 4 | Browser extension (Chrome/Firefox) detecting the active creator by URL |

**Design principle:** the API is the contract; the SPA is its first client. Phases 3–4
reuse the same API. Everything is containerized and stateless so it runs on managed PaaS
now and lifts to cloud (AWS/GCP) later without rework.

---

## 2. High-Level Architecture

```
                    ┌─────────────────────────────────────────┐
   Patreon OAuth ──▶│  Backend API (NestJS, TypeScript)        │
   TMDB API    ────▶│  - auth/session + Patreon sync           │
   Streaming API ──▶│  - recommendations, upvotes, search      │◀── Postgres (Prisma,
   ML Moderation ──▶│  - catalog intelligence (pgvector)       │        pgvector)
                    │  - moderation pipeline + flags           │◀── Redis (sessions,
                    │  - creator/mod board & policy            │        rate-limit, cache,
                    └───────────────▲─────────────────────────┘        BullMQ jobs)
                                    │ REST (JSON, /api/v1)
        ┌───────────────────────────┼───────────────────────────┐
   React+Vite+Tailwind SPA   (Phase 3) Discord bot     (Phase 4) Browser extension
```

### Stack

- **Backend:** TypeScript, **NestJS** (modules map onto subsystems: `auth`, `patreon`,
  `creators`, `recommendations`, `catalog`, `moderation`, `board`, `notifications`). Prisma ORM.
- **Frontend:** React + Vite + **Tailwind** SPA.
- **Data:** Postgres (primary; `pgvector` extension for embeddings), Redis (sessions,
  rate-limit/backoff counters, caching, BullMQ job queue).
- **External services:** Patreon OAuth + API; TMDB (identity, metadata, watch providers);
  a pluggable streaming-availability provider (Watchmode / Streaming Availability) for deep
  links; an ML moderation API (e.g. OpenAI Moderation).

### Portability (PaaS now → cloud later)

- **Docker** images for API + SPA from day one.
- Only vanilla **Postgres + Redis** (no proprietary datastores).
- **12-factor** config via env vars; backend fully **stateless** (all session/rate-limit
  state in Redis) for horizontal scale.
- Phase-1 deploy: API on Railway/Render/Fly, SPA on Vercel/Netlify, managed Postgres + Redis.
  Same containers later lift to ECS/Fargate or Cloud Run + RDS + ElastiCache.

---

## 3. Data Model (Postgres via Prisma)

Everything except global identity and the shared catalog is **scoped by `creatorId`** (the tenant).

### Tenancy & identity
- **`User`** — global Patreon-authed person. `patreonUserId`, name, avatar, email,
  **encrypted** Patreon access/refresh tokens, timestamps.
- **`Creator`** (tenant) — claimed Patreon campaign. `patreonCampaignId`, `ownerUserId`,
  `displayName`, `slug`, claimed base-URL/domain, `claimedAt`.
- **`Tier`** — mirror of a campaign's Patreon tiers. `creatorId`, `patreonTierId`, title,
  `amountCents`, `order`.
- **`Membership`** — a user's patron status for one creator (synced from Patreon).
  `userId`, `creatorId`, `currentTierId`, `amountCents`, `isActivePatron`, `lastSyncedAt`.
- **`CreatorStaff`** — verified staff designation. `creatorId`, `userId`,
  `role ∈ {OWNER, MOD}`, `assignedByUserId`. **Moderation power derives only from a row here.**

### Access policy
- **`CreatorPolicy`** (1:1 with Creator) — `viewVisibility ∈ {PUBLIC, ANY_PATREON_USER,
  SUBSCRIBERS_ONLY}`, `submitMinTierId`, `upvoteMinTierId`, optional rate-limit overrides,
  per-creator profanity blocklist, `hidePendingFromPublic` toggle.

### Shared catalog (global, cached, reused across creators)
- **`Title`** — canonical work. `tmdbId`, `mediaType ∈ {movie, tv}`, name, year, posterPath,
  overview, `embedding vector` (pgvector).
- **`TitleAlias`** — `titleId`, `language`, `kind ∈ {OFFICIAL, ROMAJI, NATIVE, ALTERNATIVE}`,
  `text`. Populated from TMDB translations + alternative_titles (EN/JA ensured for anime).
- **`TitleRelation`** — `fromTitleId`, `toTitleId`, `type ∈ {SEASON_OF, SEQUEL, PREQUEL,
  SAME_FRANCHISE, RELATED}`, `source`.
- **`Theme`** — `label`, `slug`. **`TitleTheme`** — `titleId`, `themeId`, `source ∈ {TMDB,
  EMBEDDING, CURATED}`.
- **`StreamingAvailability`** — `titleId`, `region`, `provider`, `offerType ∈ {flatrate,
  rent, buy}`, `deepLink`, `refreshedAt`.

### Recommendations
- **`Recommendation`** — `creatorId`, `submittedByUserId`,
  `type ∈ {MOVIE, SHOW, FRANCHISE, WATCH_ORDER, EXTERNAL_LINK}`, `titleId?`, `customTitle?`,
  `description`, `notes`, `status ∈ {PENDING, ACCEPTED, ACTIVE, COMPLETED, REJECTED, DELETED}`,
  `upvoteCount` (denormalized), `embedding vector`, timestamps.
  **De-dupe:** unique `(creatorId, titleId, type)` for TMDB-bound recs.
- **`RecommendationLink`** — `recommendationId`, `url`, `label`.
- **`WatchOrderItem`** — `recommendationId`, `position`, `titleId?`/`customTitle?`, `note`.
- **`Upvote`** — `recommendationId`, `userId`, unique together.

### Moderation, flags & notes
- **`ModerationResult`** — `recommendationId`, `source ∈ {WORDLIST, ML}`,
  `verdict ∈ {PASS, FLAG, BLOCK}`, `categories[]`, `score`.
- **`Flag`** — `recommendationId`, `flaggedByUserId`, `reason`, `note`,
  `status ∈ {OPEN, RESOLVED, DISMISSED}`.
- **`ModerationAction`** (audit log) — `recommendationId`, `actorUserId`,
  `action ∈ {EDIT, DELETE, MARK_FOR_DELETION, APPROVE, REJECT, RESTORE, STATUS_CHANGE}`,
  `note`, before/after snapshot, timestamp.
- **`CreatorNote`** — `recommendationId`, `authorUserId`, `body`, `kind ∈ {NOTE, TIMELINE}`.
- **`Notification`** (in-app) — `userId`, `type`, `payload`, `readAt`.
- **`AbuseRecord`** — `userId`, `strikeCount`, `timeoutUntil`, `lastViolationAt`, `history`.

---

## 4. Authentication, Patreon Integration & Access Enforcement

### Login (OAuth2 authorization-code + PKCE)
1. `GET /auth/patreon/login` → redirect to Patreon consent with `state` + PKCE challenge.
2. `GET /auth/patreon/callback` → verify `state`, exchange `code` server-side over HTTPS for tokens.
3. Call Patreon `identity` endpoint (with `memberships` + `tiers` includes) → upsert `User`
   (tokens encrypted at rest), upsert `Membership` rows, create a **server-side session**
   (record in Redis) with an httpOnly/Secure/SameSite cookie. **Rotate session on login.**

### Keeping tier status fresh
- **Primary:** Patreon webhooks (`members:pledge:create/update/delete`) → update `Membership`.
  Webhook signatures verified with **constant-time comparison**.
- **Fallback:** re-sync on login + TTL (`lastSyncedAt`) refresh via background job.

### Creator claiming
When a user who owns a Patreon campaign logs in, they can **claim** it → creates the
`Creator` tenant, imports `Tier`s, sets them `OWNER` in `CreatorStaff`, registers their
base-URL/domain (for the future extension). Ownership is verified against the Patreon API
(the campaign must belong to that Patreon user) — nobody can claim another's campaign.

### Access enforcement (NestJS guards)
A `CreatorAccessGuard` resolves the caller's `Membership` + `CreatorPolicy` per creator-scoped request:

| Capability | Rule |
|---|---|
| **View** | `PUBLIC` → anyone · `ANY_PATREON_USER` → any logged-in user · `SUBSCRIBERS_ONLY` → active patron |
| **Upvote** | active patron with tier ≥ `upvoteMinTier` |
| **Submit** | active patron with tier ≥ `submitMinTier` |
| **Moderate** | has a `CreatorStaff` row (`OWNER`/`MOD`) for that creator |

All tier/role checks are server-side; the SPA never gates security.

---

## 5. Recommendations Engine & Catalog

### Content classes
**Mainstream (TMDB-validated):** `MOVIE | SHOW | FRANCHISE | WATCH_ORDER`. On submit, the
backend does a **TMDB confirmation/reverse-lookup** to verify a *known mainstream* title
before binding a canonical `Title` (`tmdbId`). Ambiguous → return candidates to pick; no
match → prompt to refine or switch to `EXTERNAL_LINK`. `FRANCHISE` binds to a TMDB
collection and/or curated group of titles.

**External / fandom (`EXTERNAL_LINK`):** for content TMDB won't have (YouTube music videos,
one-off fandom uploads). User provides title + external link(s). No TMDB validation, but
**still** moderated + rate-limited. De-dupe by normalized URL + fuzzy title.

### Submit flow
`catalog/search` autocomplete (TMDB, cached) → pick title → add type/description/notes/links
(watch-order = ordered `WatchOrderItem`s) → **rate-limit** → **moderation pipeline** →
persist as `PENDING`.

### "Already submitted?" (de-dupe + search)
- **Canonical:** `unique(creatorId, titleId, type)` — resubmit returns the existing entry and
  invites upvote instead of erroring.
- **Semantic + fuzzy:** live search combines Postgres full-text/`pg_trgm` (over
  aliases/`customTitle`/description) **and** pgvector nearest-neighbor (semantic, cross-language)
  to surface existing/similar entries before submit.

### Upvoting
`POST /recommendations/:id/upvote` toggles an `Upvote` (tier-gated), updates denormalized
`upvoteCount`. Unlimited across entries, one per entry.

### Where-to-watch (streaming)
Two pluggable services behind interfaces:
- `CatalogProvider` → TMDB (identity/search/metadata).
- `AvailabilityProvider` → TMDB Watch Providers (free baseline badges, per region) **+**
  optional paid provider for **deep links**. Cached in `StreamingAvailability` with TTL
  background refresh; if the paid key is absent, badges still work, deep links degrade to a
  search link.

### Catalog Intelligence (embeddings, relations, themes)
- **Embeddings (pgvector):** each title+description vectorized → powers semantic de-dupe,
  **related titles**, and per-user **personalized ranking** from upvote history.
- **Relationship graph (`TitleRelation`):** `SEASON_OF`/`SEQUEL`/`PREQUEL` from TMDB
  structure (TV seasons, collection order); `SAME_FRANCHISE` from TMDB collections; `RELATED`
  from TMDB similar + embedding proximity. Submitting "Season 2" of an existing show nests it
  under the existing entry/franchise.
- **Theme taxonomy (`Theme`/`TitleTheme`):** labels like anime, k-pop, j-pop, or larger
  franchise/genre groupings; seeded from TMDB genres+keywords, expanded by embedding
  clustering, curatable by creators/mods. Enables nested/grouped board views.
- Built from TMDB structured data + off-the-shelf embeddings/NN/clustering — **no bespoke
  model training**. Isolated in its own module; sequenced *after* the core loop in the plan.

### Caching & performance
- **Local catalog as cache:** every searched/submitted title persisted (`Title` + `TitleAlias`)
  → repeat lookups never re-hit TMDB.
- **Redis hot cache:** TMDB search, metadata, availability (TTLs); per-creator "recently
  submitted/inquired" hot set.
- **Fast board queries:** denormalized `upvoteCount` + Postgres full-text/`pg_trgm` indexes.
- **Read models:** board list served as a cached, paginated projection, invalidated on write.

---

## 6. Abuse Control & Moderation (defense-in-depth)

1. **Edge / DDoS:** CDN/WAF (Cloudflare or PaaS WAF) — volumetric absorption, coarse per-IP
   limits, bot fingerprinting, optional CAPTCHA/JS challenge on bursts. Request size limits +
   strict input validation (`class-validator`).
2. **Coarse request limiter:** Redis token-bucket on all mutating endpoints, keyed by IP *and*
   user. Applies to upvotes as a generous **velocity cap** (anti-botting) without hindering normal use.
3. **Submission limiter:** per-(user, creator) **1 new rec/hour** (Redis sliding window) +
   a looser **per-user global** cap across all creators. **Upvotes exempt.**
4. **Escalating penalties (exponential backoff):** durable per-user **abuse score**. Strikes
   from repeated rate-limit hits, moderation `BLOCK`s, and mod-upheld flags. Timeout grows
   `1h→2h→4h→…→days`, **capped**, and **decays with good behavior**. State in `AbuseRecord`
   (Postgres) + Redis mirror. **No permanent lockouts** (avoids DoS-by-lockout). During a
   timeout, submission is blocked; viewing/upvoting remain unless the abuse is upvote-based.
5. **Automated moderation pipeline (on submit *and* edit):** (a) wordlist (`obscenity` +
   per-creator blocklist) → `BLOCK` on profanity/slurs; (b) ML moderation API → categories
   with thresholds. Verdicts: `PASS`→`PENDING`; `FLAG`→needs-review (surfaced to mods,
   optional auto-hide); `BLOCK`→rejected + abuse strike. Stored as `ModerationResult`;
   pipeline behind an interface for swap/extend.
6. **Community flags + human review:** any eligible user flags → `Flag(OPEN)` → notifies
   creator + verified mods; multiple flags raise priority / can auto-hide pending review.
   **Creators & verified mods only** get a review queue: resolve/dismiss, **edit/redact text**,
   mark-for-deletion, delete, reject, restore — all written to `ModerationAction`. Upheld
   flags feed the abuse score.

---

## 7. Creator/Mod Board & Submission Lifecycle

### Lifecycle
```
PENDING ──▶ ACCEPTED ──▶ ACTIVE (current) ──▶ COMPLETED
   └────────────▶ REJECTED           (DELETED = soft-delete, restorable)
```
Only `CreatorStaff` change status; every transition audited. `PENDING` entries are
**visible + upvotable by patrons by default** (the demand signal), with a
`hidePendingFromPublic` toggle.

### Two experiences over the same data
- **Patron/public board** (respects `viewVisibility`): columns **Suggestions** (`PENDING`,
  by upvotes), **Accepted**, **Now Playing** (`ACTIVE`), **Completed**. Cards show title
  (EN/JA), poster, upvotes, where-to-watch badges/deep-links, nested sequels/seasons +
  franchise/theme grouping. Filter/browse by theme or franchise; search; submit; upvote per tier.
- **Creator/mod dashboard** (kanban): drag across statuses; **Review Queue** (flagged +
  pending needing moderation); **Rejected/Deleted** bin; bulk actions. Gated to `CreatorStaff`.

### Notes & timelines
`CreatorNote` per entry — `NOTE` (editor commentary) and `TIMELINE` (scheduling/pacing,
rendered as a lightweight timeline).

### Creator admin
- **Policy:** view-visibility, submit/upvote tiers, rate-limit overrides, profanity blocklist,
  hide-pending toggle.
- **Staff:** invite/assign/remove mods (creates verified `CreatorStaff` rows).
- **Themes:** rename/merge/assign; fix relationship/nesting mistakes.
- **Claiming:** manage claimed base-URL/domain.

### Forward-compat hooks (not built in Phase 1)
Each entry reserves a place for discussion threads (Phase 2); all board actions go through the
API so the Discord bot (Phase 3) and extension (Phase 4) drive the same lifecycle.

---

## 8. API Surface

Versioned REST, `/api/v1`, JSON. The shared contract for all clients.

- **Auth/session:** `GET /auth/patreon/login`, `GET /auth/patreon/callback`,
  `POST /auth/logout`, `GET /me`
- **Creators & admin:** `POST /creators/claim`, `GET /creators/:slug`,
  `GET|PATCH /creators/:id/policy`, `CreatorStaff` CRUD, `Theme` CRUD
- **Catalog:** `GET /catalog/search`, `GET /catalog/titles/:id`, `.../availability`, `.../relations`
- **Recommendations:** `GET /creators/:id/recommendations` (filter/sort/group/nest),
  `POST` (submit), `GET /recommendations/:id`, `PATCH` (staff edit/redact),
  `POST|DELETE /recommendations/:id/upvote`, `POST /recommendations/:id/status`,
  `POST /recommendations/:id/flags`, `CreatorNote` CRUD
- **Moderation:** `GET /creators/:id/review-queue`, `PATCH /flags/:id`
- **Webhooks:** `POST /webhooks/patreon`
- **Ops:** `GET /healthz`, `/readyz`

**Background jobs (BullMQ on Redis):** availability refresh, embedding computation,
membership re-sync, abuse-score decay.

---

## 9. Security Requirements

Authentication/security is treated as a security-sensitive workflow. Note: **there are no
passwords** — identity is delegated to Patreon OAuth — so password-storage rules are N/A by
design; the principles apply to OAuth/token/session handling.

- **No credentials in URLs:** our session/access tokens never appear in URLs. Patreon's OAuth
  `?code=` is single-use, short-lived, exchanged server-side over HTTPS, hardened with **PKCE +
  `state`** (also provides OAuth CSRF protection).
- **SQL injection:** Prisma parameterizes everything; no string-built SQL; `$queryRaw` only via
  tagged-template bound params.
- **Secret handling & timing:** no plaintext secrets; Patreon tokens **encrypted at rest**
  (envelope/KMS); **constant-time comparison** for webhook signatures and session tokens.
- **Generic errors + safe error handling:** no user-enumeration; generic client messages; no
  stack traces/SQL/secrets in responses; secrets never logged (redaction).
- **Input validation:** `class-validator` DTOs on every endpoint (types, lengths, formats,
  malformed-body rejection).
- **Resource safety:** Prisma-managed pooling/transactions; no hand-rolled connection lifecycles.
- **Sessions & cookies:** server-side session in Redis; cookie `HttpOnly` + `Secure` +
  `SameSite`; **rotation after login**, **invalidation on logout**, sane expiry; **CSRF tokens**
  on state-changing requests.
- **Brute-force/abuse:** per Section 6; penalties **capped + decaying, never permanent**.
- **HTTPS:** HTTPS-only + HSTS in production; POST is not a substitute for TLS.
- **Identifier normalization:** Patreon IDs are canonical keys; any email/slug normalization is
  explicit with DB-level uniqueness.

---

## 10. Testing Strategy (TDD)

- **Unit:** moderation pipeline, rate limiter/backoff, tier/access resolver, de-dupe,
  catalog-intelligence adapters — external providers behind interfaces with **fakes**.
- **Integration:** repositories + guards against ephemeral Postgres + Redis (Testcontainers).
- **Contract/fixture:** Patreon/TMDB/availability/ML via recorded fixtures.
- **E2E API (supertest):** golden path — login → submit → de-dupe hit → upvote → moderation →
  lifecycle → flag/resolve.
- **Frontend:** Vitest + Testing Library components; a few Playwright happy-path E2Es.
- **Auth/security tests (minimum):** valid/invalid/unknown identity, missing/empty/malformed
  bodies, injection-style input rejected, generic failure responses, session created on success
  / not on failure, cookie attributes, rate-limit behavior, webhook signature verification.

---

## 11. Observability

Structured logs + correlation IDs; metrics for rate-limit hits, moderation verdicts,
external-API latency; Sentry error tracking; Prisma Migrate for schema evolution.

---

## 12. Non-Goals (Phase 1)

Deferred, not designed here:
- Discussion threads (Phase 2), Discord bot (Phase 3), browser extension (Phase 4) —
  forward-compat hooks only.
- Email/push notifications (in-app `Notification` only).
- Native mobile apps; UI i18n beyond title EN/JA translations.
- Payments/billing (Patreon owns that).
- Advanced analytics dashboards; multi-region data residency.

---

## 13. Remaining Production Considerations

Controls that cannot be proven from local code and must be handled at deploy time before
calling this production-ready: HTTPS/TLS termination + HSTS, secret management (KMS/vault for
Patreon tokens + API keys), WAF/DDoS configuration, monitoring/alerting thresholds, MFA for
creator/owner accounts where supported, Redis session-store durability/failover, database
backups + migration safety, and CORS origin allow-listing for the SPA (and later extension).

---

## 14. Open Questions / Assumptions

- **Assumption:** Patreon API tier granularity is sufficient to enforce `submitMinTier` /
  `upvoteMinTier`; verify tier ordering semantics during implementation.
- **Assumption:** TMDB Watch Providers coverage is adequate for badges in target regions;
  paid provider is optional and additive (deep links).
- **Assumption:** ML moderation provider (e.g. OpenAI Moderation) is acceptable as an external
  dependency; the pipeline interface allows swapping to a self-hosted classifier later.
- **To confirm during planning:** exact numeric thresholds (global submission cap, backoff
  base/cap, abuse-score decay rate), and target streaming regions.
