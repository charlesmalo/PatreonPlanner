# Kanban Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the board from four stacked sections into a kanban a reader can take in at a glance, and let staff move a card between columns without opening a menu.

**Architecture:** Each column fetches and paginates independently, keyed on status. The board already buckets client-side into the same four columns; that bucketing is what breaks once columns look self-contained, because one flat paginated list cannot tell a column "there are no more" from "there are more, further down the list you have not fetched".

**Tech Stack:** NestJS 10, Prisma 5.20, React 18 + Vite + Tailwind, Jest + Testcontainers, Vitest + RTL, Playwright.

## Global Constraints

- Free tooling only; no new runtime dependencies for this step (drag-and-drop is deliberately later).
- The status filter **narrows** what visibility already allows and can never widen it.
- Only staff move cards. `POST /:id/status` already exists and is capability-gated; this adds no new authority.

## Decisions this plan settles

1. **Per-column fetching, not client-side bucketing.** One flat keyset page ordered by upvotes can be entirely one status, so a column would show nothing while entries exist. Four independent cursors is the only shape where "Load more" in a column means what it says.
2. **Arrows now, drag-and-drop later.** Arrows work on touch, with a keyboard, and announce themselves to a screen reader. Drag-and-drop does none of that without significant extra work, and it is an enhancement over controls that already work rather than a replacement for them.
3. **Collapse is per-reader and local.** Which columns a reader has folded away is not board configuration and must not be visible to anyone else; it lives in `localStorage`, not the database.
4. **One column at a time on narrow screens.** Horizontal kanban on a phone is unusable and the audience is heavily mobile. Same data and same components, with a column switcher instead of a row.
5. **Moving a card is still a status change.** No new endpoint, no manual ordering yet — the design doc settles ordering as upvote-driven, with manual order arriving alongside per-column sorting.

## Scope

**In:** `status` filter on the board list; per-column pagination; horizontal columns with collapse; arrow moves for staff; narrow-screen switcher.

**Out, with reasons:**
- *Drag-and-drop* — decision 2; it lands after the arrows are proven.
- *Per-column sorting and manual order* — next step in the sequence, and it wants the rank column the design doc describes.
- *Grouping / uber-cards* — blocked on the open question about whether a group's weight sums its children.
- *Column-level bulk actions* — no evidence yet of the workflow they would serve.

## File Structure

- `apps/api/src/recommendations/dto/list-recommendations.query.ts` — `status`.
- `apps/api/src/recommendations/recommendations.service.ts` — compose the filter.
- `apps/web/src/api/hooks.ts` — `useBoardColumn`.
- `apps/web/src/components/BoardColumn.tsx` + test — one column, its own cursor and collapse.
- `apps/web/src/components/MoveControls.tsx` + test — the arrows.
- `apps/web/src/routes/CreatorBoard.tsx` — lay the columns out.

---

### Task 1: A column can be asked for on its own

- [ ] **Step 1: Write the failing tests**

```ts
it('returns only the asked-for column', async () => {
  const res = await list('?status=ACCEPTED', patron).expect(200);
  expect(res.body.items.every((i) => i.status === 'ACCEPTED')).toBe(true);
});

it('never widens what the reader may see', async () => {
  // The filter narrows visibility; it does not replace it. Asking for a column a patron cannot
  // see must be empty, not everything in it.
  const res = await list('?status=REJECTED', patron).expect(200);
  expect(res.body.items).toEqual([]);
});

it('shows staff the same column, because they work it', async () => {
  const res = await list('?status=REJECTED', staff).expect(200);
  expect(res.body.items).toHaveLength(1);
});

it('paginates within the column rather than across the board', async () => {
  const first = await list('?status=PENDING&limit=1', patron).expect(200);
  expect(first.body.items).toHaveLength(1);
  const second = await list(`?status=PENDING&limit=1&cursor=${first.body.nextCursor}`, patron);
  expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
});

it('rejects a status that is not one', async () => {
  await list('?status=BANANA', patron).expect(400);
});
```

- [ ] **Step 2: Run and verify they fail.**

- [ ] **Step 3: DTO** — `@IsOptional() @IsIn(['PENDING','ACCEPTED','ACTIVE','COMPLETED','REJECTED','DELETED']) status?: RecommendationStatus`.

- [ ] **Step 4: Service** — add to the existing `AND: [...]` composition, never by spread:

```ts
AND: [
  visibilityWhere(creator, viewer),
  ...(status ? [{ status }] : []),
  ...(cursor ? [ /* unchanged */ ] : []),
],
```

- [ ] **Step 5: Mutation-check** — moving the status filter out of the `AND` and into a spread must fail "never widens what the reader may see".

- [ ] **Step 6: Commit.**

---

### Task 2: One column, on its own cursor

- [ ] **Step 1: Write the failing tests** for `BoardColumn`: renders its entries, "Load more" appends the next page, an empty column says so, collapsing hides the entries while leaving the header and a count, and the collapsed state survives a remount.

- [ ] **Step 2: `useBoardColumn(slug, status, theme)`** — same shape as `useBoard`, one status.

- [ ] **Step 3: `BoardColumn`** — header with label and count, collapse toggle with `aria-expanded`, the entries, "Load more" when a cursor remains.

- [ ] **Step 4: Persist collapse** under `pp.board.<slug>.collapsed`, read on mount, written on toggle. Never sent to the server.

- [ ] **Step 5: Commit.**

---

### Task 3: Moving a card with arrows

- [ ] **Step 1: Write the failing tests**

```tsx
it('offers no move controls to a reader who cannot moderate', ...);
it('moves an entry to the next column', ...);          // POST /:id/status with ACCEPTED
it('disables the forward arrow in the last column', ...);
it('names the destination, so the control is not a bare arrow', ...);  // "Move to Accepted"
it('puts the entry back when the move fails', ...);    // optimistic, then reconciled
```

- [ ] **Step 2: `MoveControls`** — back and forward arrows derived from the lifecycle order, each labelled with its destination, hidden entirely without `MODERATE`.

- [ ] **Step 3: Wire into `RecommendationCard`**, and have the board move the entry between columns on success.

- [ ] **Step 4: Mutation-check** — removing the capability check must fail the first test.

- [ ] **Step 5: Commit.**

---

### Task 4: The layout

- [ ] **Step 1:** Columns in a horizontal, scrollable row on wide screens; the row itself scrolls, never the page body.
- [ ] **Step 2:** Below the breakpoint, one column with a switcher.
- [ ] **Step 3:** e2e — a staff member moves a card across two columns and it stays there after a reload; a collapsed column stays collapsed after a reload; a patron sees no arrows.
- [ ] **Step 4:** `pnpm -r test`, e2e, `format:check`, commit.

---

## Known risks

- **Four requests where there was one.** Each column fetches independently, so a board costs four round trips on load. They are parallel and each is small, but it is four times the queries for the same screen.
- **A moved card lands in a column the reader has collapsed**, and appears to vanish. The count changes, which is a weak signal; worth watching in playtesting.
- **Counts are per page, not totals.** A column header showing "3" when three are loaded and more exist is a lie of omission. Either the count says "3 of many" or the API grows a total, which is a second query per column.
- **No manual ordering yet**, so an arrow move puts a card wherever upvote order says. For a moderator arranging a schedule that will feel arbitrary until sorting lands.
