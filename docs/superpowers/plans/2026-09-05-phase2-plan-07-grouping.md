# Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let staff put related entries on one card — seasons, the same work under two titles, the same work on two platforms — without destroying any of them.

**Architecture:** An explicit `groupHeadId` on the entry, chosen by staff. The board already nests entries under a parent; this feeds that same projection, so grouping changes what nests rather than how nesting renders.

## Why an explicit column, when nesting already exists

Today's nesting is **derived** from `TitleRelation` — TMDB's own collections, keyed on `titleId`. It cannot express a staff decision, and an external-link entry has no `titleId` at all, so the most common thing a creator wants to group is exactly what the derived projection cannot reach.

So the relation is stored. The **projection** is shared: an explicit head wins, and the derived one applies to everything else.

## Decisions this plan settles

1. **The head's stored `weightedScore` becomes the group's de-duplicated total.** The board ranks on a column and pages by keyset, so a displayed weight computed separately from the ordering would put a group somewhere its number does not explain. One number, used for both.
2. **De-duplicated by voter, at their highest tier.** Someone who upvoted two entries that are then grouped counts **once**, at the best tier they used across the group. Counting them twice inflates the head silently — the trap the theme merge hit with title assignments.
3. **Grouping preserves.** Children keep their own rows, their own votes, their own pages. Ungrouping restores them intact. Nothing about this destroys an entry, which is what separates it from the theme merge.
4. **One level.** A head cannot itself be grouped, and a child cannot be a head. Arbitrary depth would make the de-duplicated sum a recursive walk and the "which card do I open" question unanswerable.
5. **`MOVE_ENTRIES` gates it.** Grouping moves a card *into* another card; that is the same family as moving one between columns, and closer than editing its text. A sixth permission would be speculative generality.

## Scope

**In:** `Recommendation.groupHeadId`; group and ungroup; recomputation of the head's totals; the board projection preferring an explicit head; the child list on the head's card.

**Out, with reasons:**
- *Ordering within a group.* Members render in the board's own order. A hand-ordered watch order is a `WATCH_ORDER` entry, which already exists.
- *Grouping across boards.* Multi-tenancy forbids it and nothing wants it.
- *The link/candidate model* (design §4). It rides along with grouping conceptually but is its own plan — provider availability and submitted URLs are different data with different trust.

## File Structure

- `apps/api/prisma/schema.prisma` + migration — `groupHeadId`.
- `apps/api/src/recommendations/grouping.service.ts` — group, ungroup, recompute.
- `apps/api/src/recommendations/recommendations.controller.ts` — two endpoints.
- `apps/api/src/recommendations/recommendations.service.ts` — the projection prefers an explicit head.

---

### Task 1: Grouping and its arithmetic

- [ ] **Failing tests:** grouping nests a child under a head; the head's weight becomes the group total; **a voter who upvoted both counts once, at their higher tier**; the headcount is distinct voters; ungrouping restores both entries' own totals; a head cannot be grouped into a third entry; a child cannot become a head; an entry on another board is a 404; a patron and a mod without `MOVE_ENTRIES` are refused.
- [ ] `groupHeadId` + migration, self-referencing, `onDelete: SetNull` — deleting a head releases its children rather than deleting them.
- [ ] `POST|DELETE /creators/:slug/recommendations/:id/group`.
- [ ] **Mutation-check:** skipping the recompute, counting a shared voter twice, and dropping the creator scope must each fail.
- [ ] Commit.

### Task 2: On the board

- [ ] **Failing tests:** a grouped child renders inside its head and not at the top level; an explicit head wins over a TMDB-derived parent; the head shows how many it carries.
- [ ] Projection change; e2e journey.
- [ ] Commit.

---

## Known risks

- **The head's totals are derived state that only grouping maintains.** A vote cast *after* grouping updates the entry it was cast on; the head is recomputed on that path too, but any future writer touching `Upvote` outside these paths would drift. The recompute is the repair; nothing detects the drift on its own.
- **One level is a real limit.** A franchise of seasons of parts cannot be expressed, and the workaround is a flat group.
- **Ungrouping restores totals by recomputation, not by memory** — correct today, and it would silently lose anything a future feature stored on the head that is not derived from votes.
