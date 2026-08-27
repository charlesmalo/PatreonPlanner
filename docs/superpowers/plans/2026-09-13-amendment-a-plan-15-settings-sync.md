# Settings That Follow You Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make column collapse and per-column sort follow a reader between devices, without taking anything away from readers who do not pay.

**Architecture:** `localStorage` stays the source of truth for the first paint, because it is synchronous and the board must not wait on a request to render. The server copy is fetched alongside and applied when it differs — which on a new device is always, and on the same device is never.

**Tech Stack:** NestJS 10, Prisma 5, React 18, Jest + Testcontainers, Vitest + RTL.

## Global Constraints

- **Free tier only.** No new dependency.
- **Nothing is withheld.** Collapse and sort keep working for everyone, per device. Premium buys only that they follow you.
- **404 not 403** for a board the reader may not see.

---

## Decisions this plan settles

- **`localStorage` first, server second.** A board that waits on a request before it can render is a worse board for everybody, including the reader who paid.
- **The server wins when they differ.** That is the whole feature: on a new device local is empty and the stored value applies with no visible change; on the same device they already agree. A jump is only possible when the two genuinely disagree, which is exactly when the stored one is the answer.
- **View-as mode is deliberately excluded.** It is a per-board, per-session safety control with an inactivity acknowledgement behind it. Syncing it would let a moderator open a second device already in patron view, with no memory of choosing it — a control that follows you is the opposite of what that one is for.
- **Reads are free, writes are premium.** A free reader gets an empty answer rather than a refusal, so nothing about the page has to know whether they pay.

## Scope

**In:** `BoardViewPreference`; `GET|PUT /creators/:slug/view-settings`; a settings module in the SPA that both `BoardColumn` and the server go through.

**Out, with reasons:**
- *Syncing view-as mode.* See above.
- *Syncing favourites.* Already server-side.
- *A general key-value preference store.* Untyped, and every consumer would have to re-derive what a valid value is.

---

### Task 1: Storing them

- [ ] **Failing tests:** a set is stored and read back; an absent row reads as empty rather than erroring; a free reader is refused a write with 402 but still reads; one board's settings stay out of another's; a status that is not a column is rejected; a board the reader cannot see is a 404.
- [ ] Schema (`collapsed RecommendationStatus[]`, `sorts Json`), migration, service, controller.
- [ ] **Mutation-check:** dropping the premium check; dropping the `creatorId` scope; accepting an unknown status.
- [ ] Commit.

### Task 2: Using them

- [ ] **Failing tests:** the first paint uses the local value without waiting; a stored value replaces it once loaded; a change writes both; a free reader's change writes local only; a failed write does not lose the local change.
- [ ] A `board-settings` module the column uses instead of reaching for `window.localStorage`.
- [ ] **Mutation-check:** waiting on the request before first paint; letting the local value win over the stored one; not writing locally when the server write fails.
- [ ] Commit.

## Known risks

- **Two sources of truth, reconciled by "last write wins".** Two devices open at once will fight, and the loser finds their column re-folded. Acceptable for collapse and sort; it would not be for anything that carried real consequence.
- **`sorts` is `Json`**, so a bad value survives the type system and only fails when a column tries to use it. The DTO validates on the way in, which is the only place it can be caught.
