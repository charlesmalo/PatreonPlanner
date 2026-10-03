# 03. Architecture & Registries

**Purpose: answer "where does X live?" in seconds, without searching the tree.**

> Update this file **in the same step** that adds a module, a shared utility, a
> domain type, or an architectural boundary. A stale map is worse than none.

## Repository Map

```
<repo>/
├── coding_agent/           agent ruleset — single source of truth (start at 00)
├── apps/api/               NestJS backend
│   ├── prisma/             schema + hand-written migrations
│   ├── src/access/         capability + permission resolution (pure)
│   ├── src/<domain>/       one folder per subsystem
│   └── test/               integration suites (Testcontainers)
├── apps/web/               React + Vite SPA
│   ├── src/api/            client, hooks, types
│   ├── src/components/     shared components
│   └── src/routes/         one file per page
├── e2e/                    Playwright journeys + the Patreon/TMDB stub
├── docs/superpowers/       specs and implementation plans
└── openspec/               spec-driven change proposals
```

## Layering

```
controllers ──▶ services ──▶ Prisma ──▶ Postgres
      │
      └──▶ guards (access) ──▶ pure resolvers (capability.ts, permissions.ts)
```

**Rules enforced by review:**

- The access resolvers are **pure**: no Prisma, no Redis, nothing to stub.
  Authorization is the part most worth exhaustive testing, and it must be
  testable without a database standing behind it.
- A controller never reaches past its service into Prisma.
- Every creator-scoped query filters on `creatorId` (`01_PROJECT_RULES.md` §7).

## Shared Utility Registry

Check here **before writing any utility** (`08_TOKEN_EFFICIENCY.md` §1).

| Utility                             | Location                                                  | Purpose                                               |
| ----------------------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| `can()`                             | `apps/api/src/access/capability.ts`                       | The whole capability table, pure                      |
| `hasPermission()`                   | `apps/api/src/access/permissions.ts`                      | Per-moderator permissions, pure                       |
| `visibilityWhere()`                 | `apps/api/src/recommendations/recommendations.service.ts` | The one visibility rule every entry read applies      |
| `boardOrdering()` / `afterCursor()` | same file                                                 | Ordering and its matching keyset, derived together    |
| `narrowCapabilities()`              | `apps/web/src/api/view-mode.ts`                           | View-as narrowing; never widens                       |
| `buildTree()`                       | `apps/web/src/components/board-tree.ts`                   | Nests entries by `parentId`, defensively              |
| `present()`                         | `apps/api/src/recommendations/recommendations.service.ts` | Renames `creatorNotes` to `notes` at the API boundary |
| `destinationFor()`                  | `apps/web/src/api/notification-destination.ts`            | Where a notification's link goes; was written twice   |
| `TicketCard`                        | `apps/web/src/components/TicketCard.tsx`                  | One message, with the answer controls when permitted  |

## Domain Model Registry

| Type                    | Kind      | Invariant it guarantees                             |
| ----------------------- | --------- | --------------------------------------------------- |
| `Capability`            | union     | The five things a viewer may be allowed to do       |
| `StaffPermission`       | enum      | What a moderator may do beyond being staff          |
| `RecommendationStatus`  | enum      | The lifecycle; transitions are a whitelist          |
| `Tier.voteWeight`       | int       | What an upvote from this tier is worth              |
| `Upvote.tierId`         | reference | The tier a vote was cast at — never a copied number |
| `Notification.severity` | int       | Ranked at write time so ordering is indexable       |

## Test Support Registry

| Fixture / Builder                             | Location                                           | Used by                                         |
| --------------------------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| `startAuthApp()`                              | `apps/api/test/support/auth-app.ts`                | Every integration suite needing a session       |
| `startDatabase()`                             | `apps/api/test/support/database.ts`                | Shared Postgres container, cloned per suite     |
| `applyTestConfigDefaults()`                   | `apps/api/test/support/env.ts`                     | Inert config so a suite boots without real keys |
| `FakeEmbeddingProvider`                       | `apps/api/test/support/fake-embedding.provider.ts` | Semantic search without loading the model       |
| `fakeApi()` / `recommendation()`              | `apps/web/src/test-support.tsx`                    | Every web test                                  |
| `seed()` / `makeStaff()` / `setTierWeights()` | `e2e/tests/support.ts`                             | Playwright journeys                             |

## Do Not Duplicate

Things that exist exactly once. Building a second one is a defect.

| Concern                 | The one implementation              | Notes                                     |
| ----------------------- | ----------------------------------- | ----------------------------------------- |
| Capability resolution   | `access/capability.ts`              | Pure; never inline an equivalent check    |
| Permission resolution   | `access/permissions.ts`             | Fails closed twice over                   |
| Entry visibility        | `visibilityWhere()`                 | Compose with `AND`, never spread          |
| Board ordering + keyset | `boardOrdering()` / `afterCursor()` | They must agree or paging breaks silently |
| Moderation pipeline     | `moderation/moderation.service.ts`  | One `review()`, which also records        |
| Notification links      | `destinationFor()`                  | Two copies is how `ticketId` went unread  |

## Key Decisions

| Date    | Decision                                                             | Because                                                                                                                                      | Rejected alternative           |
| ------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 2026-08 | Composition with `AND`, never object spread, in every Prisma `where` | A spread lets a later key overwrite the visibility filter; page two of every board once returned rejected and other patrons' pending entries | Spreading for brevity          |
| 2026-08 | 404, not 403, for an entry the reader may not see                    | Telling a reader an id exists but is not theirs confirms what sits on a board they cannot see                                                | 403 as the "honest" status     |
| 2026-08 | Weighted score is a stored column, recomputed on rebalance           | It is the board's sort key, and a keyset cursor cannot order by a sum computed after the query returns                                       | Per-tier counts summed on read |
| 2026-08 | View-as narrows capabilities client-side only                        | If the mode were an authorization input, a toggle in the browser would be a security boundary                                                | Sending the mode to the server |
| 2026-08 | Local ONNX embeddings on CPU                                         | Free-tier-only constraint rules out every hosted embedding API                                                                               | OpenAI / Voyage / Cohere       |
