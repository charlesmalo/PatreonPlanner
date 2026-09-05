# Playtest Round One Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix everything the first playtest turned up, in the order of how much harm it does.

**Tech Stack:** NestJS 10, Prisma 5.20 + Postgres 16, React 18 + Vite + Tailwind, Playwright.

## Global Constraints

- Every dependency free. Nothing below needs a new one.
- `pnpm -r test` does not typecheck. Verification is `pnpm -r typecheck` **and** `pnpm -r coverage`.
- Never edit an applied migration — Prisma checksums it.
- A test must be able to fail for its own reason.

---

## What was reported, and what is actually wrong

Investigated before planning. Three of the five are smaller than they look, and one is not a
product bug at all.

| Reported | Actually |
| --- | --- |
| "Message moderator shows when signed out" | **UI gating bug.** The server already refuses — `allowAnonymousTickets` defaults to false and `tickets.service` checks it. The board renders `ContactForm` behind `capabilities.view`, so an anonymous reader is shown a form that will be rejected. |
| "Most upvoted is not sorting" | **Demo data, not the product.** `upvotes.service` maintains `weightedScore` correctly on cast and withdraw. `seed-demo.ts` writes `upvoteCount` directly and never touches `weightedScore`, so every row is 0, everything ties, and the sort falls through to `createdAt`. |
| "Board is trapped in a narrow column" | **Real.** The board renders inside `Layout`'s `max-w-3xl` prose container. |
| "No zoom, pan, or touch navigation" | **Real, and the largest piece of work here.** |
| "Creators should control each permission" | **Mostly exists.** `viewVisibility`, `submitMinTierId`, `upvoteMinTierId`, `hidePendingFromPublic`, `allowAnonymousTickets` are all already in `CreatorPolicy`. What is missing is a **UI to set any of it**, and the default for `viewVisibility` is `PUBLIC`. |

---

### Task 1: No write control is shown to somebody who cannot use it

**Files:** `apps/web/src/routes/CreatorBoard.tsx`, `apps/api/src/recommendations/*`,
`apps/web/src/routes/CreatorBoard.test.tsx`, `e2e/tests/journey.spec.ts`

The board decides what to render from `capabilities`, and `capabilities` has no answer for "may
this person open a ticket". `ContactForm` therefore sits behind `capabilities.view`, which is true
for an anonymous reader of a public board.

- [x] **Step 1:** Failing test — an anonymous reader of a public board sees no contact form, and a
      signed-in one does.
- [x] **Step 2:** Add `contact` to the capabilities payload, resolved server-side from
      `allowAnonymousTickets` and whether the reader is authenticated. The server is already the
      authority; this only stops the UI offering what the server will refuse.
- [x] **Step 3:** Audit every other control on the board against its capability — upvote, submit,
      react, drag, move. Anything offered without one gets a test.
- [x] **Step 4:** Commit.

### Task 2: The sort tells the truth

**Files:** `apps/api/scripts/seed-demo.ts`, `apps/api/test/board-sorting.int-spec.ts`

- [x] **Step 1:** Failing test — a board seeded with upvotes orders by them under `upvotes`.
- [x] **Step 2:** Seed through the real path, or set `weightedScore` alongside `upvoteCount`.
      Directly writing one of a pair of derived columns is what produced this.
- [x] **Step 3:** Rename the control. It orders by `weightedScore`, which is tier-weighted, so
      "Most upvoted" is not what it does — a $15 patron's vote counts for more than a $5 one's, by
      design. **Top rated** or **Most supported** says that without lying.
- [x] **Step 4:** Commit.

### Task 3: The board gets the whole window

**Files:** `apps/web/src/components/Layout.tsx`, `apps/web/src/routes/CreatorBoard.tsx`

`Layout` wraps every route in `max-w-3xl`, which is right for reading and wrong for a board.

- [x] **Step 1:** Let a route opt out of the prose width rather than removing it globally — the
      landing page, settings and notifications all want it.
- [x] **Step 2:** The board fills the viewport, columns laid out across it.
- [x] **Step 3:** Browser test at laptop width: all four columns visible without horizontal
      scrolling, no dead margin.
- [x] **Step 4:** Commit.

### Task 4: Moving around the board

**Files:** `apps/web/src/components/BoardViewport.tsx` (new), `e2e/tests/board-navigation.spec.ts`

The largest piece. A viewport wrapping the columns, with:

- [x] **Step 1:** **Pan by dragging the background.** Only the background — a drag starting on a
      card is a card drag, and the two must not fight. The existing drag-and-drop is what decides.
- [x] **Step 2:** **Wheel behaviour.** Vertical wheel scrolls the board vertically; horizontal
      wheel and shift-wheel move it sideways; **ctrl/⌘ + wheel zooms**, which is what a trackpad
      pinch actually sends.
- [x] **Step 3:** **Touch.** Two-finger pinch to zoom, one finger to pan.
- [x] **Step 4:** Zoom bounds and a reset control, so nobody can lose the board off-screen.
- [x] **Step 5:** **Keyboard equivalents for every gesture**, or the board becomes mouse-only.
      Arrow keys pan, `+`/`-` zoom, `0` resets.
- [x] **Step 6:** Browser tests for each. jsdom dispatches no real gestures.
- [x] **Step 7:** Commit.

### Task 5: A board is private until its creator says otherwise

**Files:** `apps/api/prisma/schema.prisma`, migration, `apps/web/src/routes/BoardSettings.tsx` (new)

The reported reason is specific and worth writing down: **bots scan public boards for what a
creator is watching and file fraudulent DMCA claims from it.** A board that lists "Now Playing" in
public is a target list. Defaulting to public makes every new creator one by accident.

- [x] **Step 1:** Change the default for `viewVisibility` to `SUBSCRIBERS_ONLY`. Additive
      migration: **existing boards keep what they have** — silently making live boards private is
      as bad as the reverse.
- [x] **Step 2:** A settings page where a creator, or a moderator holding the right permission,
      sets visibility, the submit and upvote tier gates, `hidePendingFromPublic`, and
      `allowAnonymousTickets`. The model already carries all of it.
- [x] **Step 3:** Say what each choice exposes, in the page. A creator choosing "public" should
      know it means a list anyone can read.
- [x] **Step 4:** Commit.

---

## What it found

Every task turned out smaller or different from the report, and the differences are the
interesting part.

**Two of the five were not product bugs.** The contact form was a UI gating bug over a server that
already refused. The sort was the *demo seed* writing one of a pair of derived columns, so every
weighted score was zero and everything tied — the product was correct and the demo was lying, which
a play-tester has no way to tell apart.

**The board redesign replaced tasks 3 and 4 rather than completing them.** The report asked for a
widescreen board with zoom and pan; the follow-up asked for one column at a time, tabbed, with the
neighbours dragged in. Tabs answer the truncation the zooming was for, so only swiping survived
from that list.

**Task 5 was mostly already built.** `viewVisibility`, the tier gates, `hidePendingFromPublic` and
`allowAnonymousTickets` were all in `CreatorPolicy`, and `GET`/`PATCH policy` had existed since
plan 03. What was missing was a UI, the default, and four settings that were in the database and
reachable by nobody.

**Changing the default broke 51 tests, and not one was a bug.** They were relying on an implicit
default: 42 files created a board with `policy: { create: {} }` and then read it anonymously. They
state what they need now, which is better than what they did before.

**`MANAGE_POLICY` closed the gap between the ask and the delivery.** "Creators and their mods" got
owner-only first; delegating it properly wanted a permission of its own rather than folding board
settings into moderation.

**jsdom cannot test a gesture.** It defines no `PointerEvent`, so pointer events arrive without
type or coordinates and every deltas is NaN. That found the defect worth keeping from this round:
the swipe guards compared distances without checking the numbers were real, and `Math.abs(NaN) < 48`
is false — so they failed **open**, and the board changed column on an empty event.
