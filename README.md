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
