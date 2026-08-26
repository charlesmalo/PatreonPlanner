# Splitting `recommendations.service.ts` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get the project's largest file under the limit `04_CODE_STANDARDS.md` §1 sets, without changing a single behaviour.

**Architecture:** Pure extraction. Every task moves code that already exists into a module named for what it does, updates imports, and proves nothing changed by the suite that already passes. No signature is redesigned, no behaviour is "improved on the way past" — a refactor that also fixes things cannot be verified by the tests that passed before it.

**Tech Stack:** NestJS 10, Prisma 5, Jest + Testcontainers.

## Global Constraints

- **Free tier only.** No new dependency of any kind.
- **Behaviour-preserving.** 840 API tests, `pnpm -r typecheck`, and the coverage gate all pass before and after each task, with the same numbers.
- **No drive-by fixes.** Anything worth changing gets noted and left alone. If a real bug surfaces mid-move, stop, land the move, then fix it in its own commit with its own test.

---

## Why this file is the one

`recommendations.service.ts` is 1061 lines against a 300-line limit — 3.5× over, and the largest file in the repo by more than double. It is also the file every board change touches, so its size is paid repeatedly.

The limit exists because a file you cannot hold in context at once is a file you edit by guessing. This one has already produced that outcome: three call sites returned rows selected *before* the write that changed them, which is a mistake much harder to make when the read and the write are visible together.

## What is actually in there

| Concern | Lines | Moves to |
| --- | --- | --- |
| Response projection — `present`, `recommendationFields`, `BOARD_ONLY_DEFAULTS` | ~90 | `recommendation-fields.ts` |
| Ordering, cursors, visibility — `boardOrdering`, `afterCursor`, `encodeCursor`, `decodeCursor`, `visibilityWhere` | ~140 | `board-query.ts` |
| Submission — `submit`, `create`, `resolveTitle`, `resolveItems`, the strike counters | ~330 | `submissions.service.ts` |
| What is left — `list`, `findOne`, `toggleUpvote`, `setCreatorPick`, `parentsFor`, `themesFor` | ~330 | stays |

## Decisions this plan settles

- **Two pure-function modules first, the service extraction second.** Moving module-level functions cannot break dependency injection; moving methods onto a new `@Injectable` can. Doing the safe half first means a failure in the second half has a small, obvious cause.
- **`submissions.service.ts` is a new provider, not a static helper.** `submit` needs `PrismaService`, `AbuseService`, `RateLimitService`, `ModerationService`, `CatalogService` and `LinksService`; passing six collaborators to a free function is a constructor with extra steps.
- **Ordering and its cursor stay in one module.** They are derived together on purpose — a board pages silently wrong when they disagree, which this codebase has already paid for once.

## Scope

**In:** moving the four groups above; updating imports; keeping every export that a test or another module already reaches for.

**Out, with reasons:**
- *Splitting `hooks.ts` (482) or `SubmitForm.tsx` (405).* Real, smaller, and a different risk profile — they own React state, not a database. Their own task.
- *Changing any method signature.* The point of this plan is that the diff is provably inert; a signature change forfeits that.
- *Adding tests.* Coverage is already 97.3% on this file's behaviours. New tests here would be written against code that just moved, which proves nothing about the move.

---

### Task 1: The projection module

**Files:**
- Create: `apps/api/src/recommendations/recommendation-fields.ts`
- Modify: `apps/api/src/recommendations/recommendations.service.ts`, `search.service.ts`

- [x] **Step 1: Move `BOARD_ONLY_DEFAULTS`, `SelectedLink`, `present`, `recommendationFields`, and the `visibleLinks`/`LinkViewer` re-export** into the new file, verbatim, with their comments.
- [x] **Step 2: Re-export from `recommendations.service.ts`** so no importer changes in this task. One move at a time, one reason to fail.
- [x] **Step 3: Verify.** `pnpm -r typecheck` and `cd apps/api && pnpm test`. Expected: 840 passed, unchanged.
- [x] **Step 4: Commit.**

### Task 2: The board query module

**Files:**
- Create: `apps/api/src/recommendations/board-query.ts`
- Modify: `apps/api/src/recommendations/recommendations.service.ts`

- [x] **Step 1: Move `MAX_PAGE`, `HIDDEN_STATUSES`, `BoardSort`, `BoardCursor`, `boardOrdering`, `afterCursor`, `encodeCursor`, `decodeCursor`, `visibilityWhere`** verbatim.
- [x] **Step 2: Re-export the names other modules already import** (`visibilityWhere`, `BoardSort`) from the service.
- [x] **Step 3: Verify.** Same two commands, same numbers.
- [x] **Step 4: Commit.**

### Task 3: The submissions service

**Files:**
- Create: `apps/api/src/recommendations/submissions.service.ts`
- Modify: `recommendations.service.ts`, `recommendations.module.ts`, `recommendations.controller.ts`

- [x] **Step 1: Move `submit`, `create`, `resolveTitle`, `resolveItems`, `recordStrike`, `countDuplicate`, `countTowardStrike`, `refund`** and the two strike thresholds onto a new `@Injectable() SubmissionsService`.
- [x] **Step 2: Register it** in `recommendations.module.ts` and inject it where `submit` is called.
- [x] **Step 3: Verify.** Both commands, plus `pnpm coverage` — a provider that failed to register shows up as a whole suite erroring, not as one test.
- [x] **Step 4: Commit.**

### Task 4: Confirm the limit is met

- [x] **Step 1:** `wc -l apps/api/src/recommendations/*.ts`. Every file under 300, or the remainder recorded in `PROGRESS_TRACKER.md` with what is still in it and why.
- [x] **Step 2:** Full verification set, and `pnpm coverage` compared against the numbers in `07_TESTING_STANDARDS.md` §3. A pure move should not shift them.
- [x] **Step 3: Commit.**

## What it actually took

Seven modules, not four. Two seams only became visible once the file was small
enough to read: catalogue resolution is the only part that talks to TMDB, and
the strike counters are all side effects of decisions made elsewhere. Both were
extracted again from `submissions.service.ts` to get it under the limit.

`withUpvoted` became a free function in the projection module. Both halves need
it, and the alternative was one service importing the other.

Six of the ten constructor dependencies on the remaining service were dead once
the methods that used them had left — which is the clearest evidence the seams
were real, and what finally took the file from 310 to 298.

| File | Lines |
| --- | --- |
| `recommendations.service.ts` | 1061 → 298 |
| `submissions.service.ts` | new, 297 |
| `board-query.ts` | new, 169 |
| `submission-resolver.service.ts` | new, 151 |
| `upvotes.service.ts` | new, 128 |
| `recommendation-fields.ts` | new, 126 |
| `submission-strikes.service.ts` | new, 74 |

877 tests before and after. Coverage 97.41% lines against 97.3% — a pure move
should not shift it, and it did not.

## Known risks

- **A circular import.** `links.service.ts` already had to receive `visibleLinks` for exactly this reason; splitting further creates more chances. The symptom is an `undefined` at module load, not a type error.
- **Nest resolves providers by token, and a missed registration fails at boot** — every suite in the app errors at once rather than one test failing, which reads as something much worse than it is.
- **Re-exports left in place forever.** They exist to keep each task's diff small; Task 4 should remove any that no longer earn their keep, or say why they stay.
