# Drag and Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let staff move a card by dragging it, and arrange a column by hand.

## What this is allowed to be

**An enhancement over a control that already works.** Every card already carries a status menu — a real button opening a real menu of real menu items, which works with a keyboard, with a screen reader, and on touch. Drag-and-drop adds a faster way to do the same thing for someone using a mouse.

That is what makes it safe to build. The design's rule was never "arrows specifically"; it was that dragging must not be the only way to move a card. The menu satisfies that, and it stays.

**Native HTML5 drag events, no library.** A drag-and-drop library is a new dependency and real bundle weight for a convenience layer. Native events do not work on touch — which is exactly why the menu is not going anywhere, and why this is scoped as a desktop nicety.

## Decisions this plan settles

1. **Dragging between columns changes status, through the endpoint the menu already uses.** No second write path, no second set of rules to keep in step.
2. **Dragging within a column changes position, and only in manual sort.** In any other sort the position is computed from upvotes or age, so preserving a hand-placed position would be a promise the next render breaks.
3. **Manual order ships with this**, because a manual sort mode with no way to reorder is a mode nobody can use.
4. **Fractional ranks, not integers.** Inserting between two cards must not renumber the column; a midpoint keeps the write to one row.
5. **A drop is a request, not a fact.** The card moves optimistically and the column refetches, so a refused move corrects itself rather than lying.

## Scope

**In:** `Recommendation.manualRank`; a `manual` sort; a reorder endpoint; drag handlers on cards and columns; the drop affordance.

**Out, with reasons:**
- *Touch dragging.* Native events do not support it, and a library is a dependency for something the menu already does on touch.
- *Dragging into a group.* Grouping is a deliberate act with arithmetic behind it; doing it by accident with a stray drop would be unpleasant to undo.
- *Multi-select drag.* No evidence anyone wants to move several at once.

---

### Task 1: A hand-made order

- [ ] **Failing tests:** `sort=manual` orders by rank; an entry with no rank sorts last and stably; reordering writes a rank between its neighbours; reordering to the top and the bottom both work; paging by manual rank neither repeats nor skips; a patron and a mod without `MOVE_ENTRIES` are refused; another board's entry is a 404.
- [ ] `manualRank Float?` + migration.
- [ ] `PATCH /creators/:slug/recommendations/:id/rank` taking the neighbours it was dropped between.
- [ ] **Mutation-check:** ignoring the rank in the ordering, and computing a rank outside its neighbours, must each fail.
- [ ] Commit.

### Task 2: Dragging

- [ ] **Failing tests:** dropping on another column sends a status change; dropping within a column in manual sort sends a rank; dropping within a column in any other sort sends nothing; a reader who cannot moderate cannot drag; a card dropped on itself does nothing.
- [ ] Handlers on the card and the column; a visible drop target.
- [ ] Commit.

---

## Known risks

- **Float ranks exhaust precision** after roughly fifty insertions between the same adjacent pair. A board would have to be arranged very deliberately to reach it, and the repair is renumbering the column — but nothing does that automatically.
- **Native drag does not work on touch**, so on a phone the menu is the only way. That is by design and the menu is not going anywhere, but it does mean the two input methods differ.
- **Manual order is per column.** Moving a card between columns in manual sort leaves it unranked in its new column, so it lands at the bottom.
