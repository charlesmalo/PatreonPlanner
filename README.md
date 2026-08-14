# PatreonPlanner

A recommendation and planning web app for Patreon creator communities.

Monorepo: `apps/api` (NestJS) and `apps/web` (Vite + React + Tailwind), managed with pnpm.

## Prerequisites

- Node 20 (see `.nvmrc`)
- pnpm 9.12.0 (`corepack enable`)
- Docker — required for local infrastructure _and_ for the API's integration tests

## Local setup

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm --filter @app/api prisma:generate
```

If host port 5432 or 6379 is already in use, set `POSTGRES_PORT` / `REDIS_PORT` in `.env` and
update `DATABASE_URL` / `REDIS_URL` to match. Compose binds both services to `127.0.0.1` only.

## Running

```bash
pnpm --filter @app/api start:dev   # http://localhost:3000
pnpm --filter @app/web dev         # http://localhost:5173, proxies /api and /auth to the API
```

Open a creator's board at `/c/<slug>`. The SPA reads `GET /creators/:slug/capabilities` to decide
which controls to render — the server still decides what is allowed, so a forged flag only
produces a visible error.

The SPA and API share one origin: Vite proxies `/api` and `/auth` to the API in development, and
nginx does the same in production. See
[the decision record](docs/decisions/2026-08-08-same-origin-deployment.md) for why, and keep
`vite.config.ts` and `nginx.conf` in step.

The REST surface is served under `/api/v1`. The ops probes and OAuth routes stay at the root:

- `GET /healthz` — liveness; touches no dependency
- `GET /readyz` — readiness; checks Postgres and Redis, `503` if either is down
- `GET /auth/patreon/login` → `GET /auth/patreon/callback` — Patreon OAuth
- `POST /auth/logout` — destroys the session
- `GET /api/v1/me` — the authenticated user
- `GET /api/v1/creators/:slug/recommendations` — the board, paginated by cursor (`VIEW`)
- `GET /api/v1/creators/:slug/catalog/search?q=` — film and show search, cached (`SUBMIT`)
- `POST /api/v1/creators/:slug/recommendations` — submit a catalogue title (`type`+`tmdbId`) or an external link; `200` + `duplicate: true` if it already exists (`SUBMIT`)
- `POST /api/v1/creators/:slug/recommendations/:id/upvote` — toggle an upvote (`UPVOTE`)
- `POST /webhooks/patreon/:creatorId` — Patreon events; authenticated by that creator's HMAC secret, exempt from CSRF

## Webhooks

Each creator registers their **own** webhook secret — Patreon issues one per webhook, and a
webhook belongs to one campaign, so a single shared secret could neither serve more than one
creator nor stop its holder forging events for the rest. Staff `PUT` it to
`/api/v1/creators/:creatorId/webhook-secret`; it is encrypted at rest like the OAuth tokens.

The callback URL to register in Patreon's portal is
`https://<your-origin>/webhooks/patreon/<creatorId>`; the creator id is in the path so the right
secret can be selected before the body is trusted. Events whose campaign does not match that
creator are discarded.

Ordering caveat: Patreon retries failed deliveries, so a `pledge:create` can in principle arrive
after a later `pledge:delete` and re-activate a lapsed membership until the next login or TTL
refresh. Nothing orders events today.

Missing webhooks degrade rather than break: a BullMQ job re-syncs any membership whose
`lastSyncedAt` is older than `MEMBERSHIP_TTL_HOURS` (default 24), and re-imports creator tiers on
the same pass. Set `JOBS_ENABLED=false` to run an instance that serves traffic but schedules
nothing.

State-changing requests need the `pp_csrf` cookie echoed in an `x-csrf-token` header. The token is
signed and bound to the session, and is re-minted automatically on any safe request.

## Board search

`GET /creators/:slug/recommendations/similar?q=…` finds entries that look like what someone is
typing, so a patron sees "already on the board — upvote instead?" before submitting a duplicate.

Built on **`pg_trgm`** — a Postgres contrib extension, already in the image. No vendor, no key, no
per-call cost.

- Similarity runs over `normalizedTitle`, the same lowercased, punctuation-stripped string
  de-duplication uses, so "The Matrix!" and "the matrix" are one target rather than two.
- **`TitleAlias` is searched too**, so "Your Name" finds an entry named 君の名は。 — the one piece
  of cross-language matching available without an embedding model.
- `SEARCH_SIMILARITY_THRESHOLD` (default `0.3`, pg_trgm's own) tunes how loose a match is; the
  right value is corpus-dependent.

**Candidates come from SQL; visibility comes from the board's read model.** The raw query returns
ids and scores only, and those ids then go through the same `visibilityWhere()` the board uses — so
a change to the visibility rules cannot leave search behind. Writing the status filter into the SQL
would have been shorter and would have diverged the first time those rules changed.

Not built: semantic / cross-language matching beyond aliases, which needs an embedding model.

## Notes & timelines

Staff can write two kinds of note on an entry (design §7):

| Kind       | Who sees it                     | Carries a date |
| ---------- | ------------------------------- | -------------- |
| `NOTE`     | staff only, in the review queue | no             |
| `TIMELINE` | **everyone**, on the board card | optional       |

That split is the whole model. The visibility rule lives in the read projections — the board
selects `kind: 'TIMELINE'` and the queue selects everything — so a `NOTE` cannot reach a patron by
way of a caller who forgot to filter. Both directions are tested, and the E2E asserts the private
body appears nowhere in the rendered page.

A timeline note is public the moment it is written; there is no draft state, so the editor
defaults to `NOTE` and warns before you switch. Notes are moderated like any other text, capped
per entry, ordered oldest-first, and deleted outright rather than hidden.

## Moderators

A creator invites moderators with a single-use link and can remove them at any time.

- `MANAGE_STAFF` is **owner-only** (`capability.ts`). A mod who could appoint mods could appoint
  an accomplice; one who could remove staff could remove the owner.
- `POST /creators/:slug/staff/invites` returns the token **once**; only its SHA-256 is stored, so
  a database read cannot recover a live invite. Invites are single-use, expire in 7 days, and are
  capped at 10 outstanding.
- `POST /staff/invites/accept` is mounted outside `creators/:slug`: the invitee does not know
  which board the token is for until they redeem it. Accepting is an authenticated action —
  nobody becomes a moderator without doing it themselves.
- Every failure to redeem answers identically. Distinguishing expired from spent from unknown
  turns the endpoint into a token oracle.
- `DELETE /creators/:slug/staff/:userId` refuses to remove the last owner: a board with no owner
  is unadministrable and no endpoint can put one back.

The invite link is a bearer credential in whatever channel the creator sends it through. Single
use and expiry bound that; nothing else does.

## Abuse scoring

A durable per-user strike count (`AbuseRecord`) drives an escalating, capped, decaying timeout
(design §6.4).

| Strikes | Timeout                                              |
| ------- | ---------------------------------------------------- |
| 1       | none — one blocked word is a mistake, not a campaign |
| 2       | 1 hour                                               |
| 3       | 2 hours                                              |
| n       | doubling, capped at **7 days**                       |

**Strikes come from** a moderation `BLOCK`, a rate-limit hit, a flag a moderator _upholds_ (never
one they dismiss — that would make reporting a weapon against the person reported), and repeated
de-duplicated resubmissions.

**A timeout blocks submission only.** Viewing and upvoting continue: losing a board you paid for is
out of proportion to a blocked word. The refusal is a `403` carrying `retryAt` and nothing else —
explaining the rule invites gaming it.

**No permanent lockouts.** The cap is the point: an uncapped penalty is a denial-of-service anyone
can trigger on someone else's behalf. Strikes decay one per quiet day, and the record is deleted
when the last one goes.

## Relations & themes

Titles carry a relation graph and a theme taxonomy, both built from TMDB's structured data by a
background job (`enrich-title.job.ts`) — never in the submit path, which is already the slowest
and most abusable one.

- **`TitleRelation`** is directional, member → container: `SAME_FRANCHISE` from a film's
  `belongs_to_collection` and a collection's `parts`, `RELATED` from TMDB's similar titles.
- **Nesting is a per-board projection**, not a stored field. Whether an entry has a parent depends
  on what else is on _that_ board, which changes with every submission and status change. Only
  containment kinds nest — `RELATED` means "similar", and nesting on it would bury unrelated
  entries.
- **Themes are creator-scoped**, seeded from TMDB genres and keywords. Re-seeding matches on
  `sourceKey` (the TMDB label), never the display name, so a creator's rename survives it.
  `GET|PATCH|DELETE /creators/:slug/themes` and `?theme=<id>` on the board.

Without `TMDB_API_KEY` there are no relations and no themes; the board renders unnested and
unfiltered.

Not built: embeddings, semantic de-dupe and personalised ranking — they need an embedding vendor,
and that is a separate plan written once one is chosen.

## Content classes

A suggestion is one of five kinds (design §5):

| Type             | Binds                                                           | De-duplicates on         |
| ---------------- | --------------------------------------------------------------- | ------------------------ |
| `MOVIE` / `SHOW` | a TMDB film or series                                           | `(creator, title, type)` |
| `FRANCHISE`      | a TMDB **collection** — a `Title` with `mediaType = COLLECTION` | `(creator, title, type)` |
| `WATCH_ORDER`    | nothing; carries ordered `WatchOrderItem` steps                 | normalized outer title   |
| `EXTERNAL_LINK`  | nothing                                                         | normalized title         |

A watch order's steps are numbered `0..n-1` **by the server** from the order they arrive in; a
client-supplied position is not trusted. Each step is either catalogue-bound or free text, never
both — enforced by a check constraint as well as by the service, so "and then the fan edit" stays
expressible without giving up canonical names for the steps TMDB does know.

Not built: automatic nesting (submitting "Season 2" under an existing show), themes, and a
franchise's member titles — all need the relationship graph, which is its own plan.

## Where to watch

Catalogue-bound entries carry streaming availability from TMDB's watch-provider data, stored per
`(title, region)` in `StreamingAvailability`.

- `AVAILABILITY_REGION_DEFAULT` (ISO-3166-1 alpha-2, default `US`) is the region the board renders.
- `AVAILABILITY_TTL_HOURS` (default 24) is how long a stored row is served before it is re-asked.
- Without `TMDB_API_KEY` the whole feature degrades to no badges. The board still renders.

Reads are **stale-while-revalidate**: a board read returns what is stored and queues a refresh for
anything missing or expired, so a cold board renders without badges and has them on the next read.
A background job refreshes the oldest rows on the same tick as the membership sync.

**Attribution.** TMDB sources this data from JustWatch and their terms require naming them wherever
it appears. `AvailabilityBadges` renders that line; do not remove it.

## Submission lifecycle

```
PENDING ──▶ ACCEPTED ──▶ ACTIVE ──▶ COMPLETED
   └──────────────▶ REJECTED          (DELETED = soft delete, restorable)
```

Only a `CreatorStaff` member moves an entry, via
`POST /api/v1/creators/:slug/recommendations/:id/status`. The legal moves are a whitelist in
`apps/api/src/moderation/transitions.ts`; anything else answers `409`. Restoring a `REJECTED` or
`DELETED` entry returns it to `PENDING` — the row does not record where it came from.

Every transition, redaction and flag resolution writes a `ModerationAction` **in the same
transaction as the change**, carrying before/after snapshots of the fields it touched.

**Visibility.** Patrons see `PENDING`, `ACCEPTED`, `ACTIVE` and `COMPLETED`; staff see everything.
With `CreatorPolicy.hidePendingFromPublic` on, pending entries are hidden from everyone except
staff and each entry's own submitter — who must keep seeing their submission, or the submit form
looks broken.

**Flags.** Any viewer with `VIEW` can report an entry
(`POST .../recommendations/:id/flags`), one flag per person per entry. Staff work them at
`GET /api/v1/creators/:slug/review-queue`, ordered by open flag count then age, and resolve or
dismiss with `PATCH /api/v1/creators/:slug/flags/:flagId`.

Not yet built: ML moderation, abuse scoring, notifications, creator notes, kanban drag-and-drop
and bulk actions — see the plan's Scope section for why each waits.

## Test infrastructure

`pnpm --filter @app/api test` runs **one** Postgres and **one** Redis for the whole run
(`test/global-setup.ts`). Migrations are applied once into a template database, and each suite
clones it with `CREATE DATABASE … TEMPLATE …` — a file copy. Isolation is unchanged: every suite
still gets a private database built from the committed migrations, so a missing migration still
fails the suite rather than passing against a shape that only exists in test code.

Before this, every database-backed suite started its own container _and_ replayed the whole
migration chain: 30 container starts and 30 migrations per run, about five seconds a suite before
a single test ran. The run went from ~160s to ~28s, and the Docker contention it created was the
cause of a long-running intermittent failure — Prisma connect and operation timeouts
(`P1002`/`P1008`/`P1017`) surfacing as a bare 500 in whichever suite was unlucky.

Two suites deliberately keep their own containers: `readiness.int-spec` stops Redis to prove
`/readyz` degrades, and stopping the shared server would end the run.

Sharing Redis relies on suites running sequentially, which the test script pins with
`--runInBand`. It is flushed at suite start, not teardown, so a crashed suite cannot leave keys
for the next one.

## Verification

```bash
pnpm -r typecheck
pnpm -r test
pnpm format:check
```

### End-to-end

```bash
pnpm --filter @app/e2e stack:up     # builds and starts the real images plus a Patreon stub
pnpm --filter @app/e2e e2e          # drives them with Playwright
pnpm --filter @app/e2e stack:down
```

This is the only suite that exercises the contract _between_ the SPA and the API. Component tests
use a fake client and API tests use supertest against the module, so a route the SPA calls at a
path the API does not mount passes both — that exact bug shipped once. The stack runs under its
own compose project name, so it never touches your dev containers.

`apps/api`'s readiness test starts its own Postgres and Redis with Testcontainers, so Docker must
be running. Testcontainers does not read Docker CLI contexts, so `apps/api/test/global-setup.ts`
resolves the active context into `DOCKER_HOST` — this is what makes Colima and OrbStack work
without any manual environment setup.

## Docker images

```bash
docker build -f apps/api/Dockerfile -t patreonplanner-api .
docker build -f apps/web/Dockerfile -t patreonplanner-web .
```

Both are built in CI. The API image runs as the unprivileged `node` user with production-only
dependencies; the web image serves the built SPA from nginx.

## Documentation

- Design: `docs/superpowers/specs/2026-08-03-patreonplanner-phase1-design.md`
- Plans: `docs/superpowers/plans/`
- Decisions: `docs/decisions/`
