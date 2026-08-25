# Reactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give enthusiasm somewhere to go that is not the upvote button.

**Why this is not a cosmetic feature.** Today "yes!" and "I would watch this" are the same click, so hype pollutes the exact signal the board exists to produce. A separate channel lets people react without touching ranking.

## Decisions this plan settles

1. **Reactions never enter an ordering.** One per person per emote, unweighted, and not an input to any sort. The moment they influence rank they are a second voting system with none of the tier weighting that makes the first one meaningful — and one anybody can flood.
2. **A curated set we ship, never uploaded images.** Uploads mean hosting, storage, and a content-moderation surface considerably worse than text — and the first CDN bill breaks the free-only constraint.
3. **Nullable foreign keys per subject, not a polymorphic `(type, id)` pair.** A polymorphic pair cannot carry a foreign key, so deleting an entry would leave orphaned reactions behind and nothing would notice. Two nullable columns with a check constraint keep the cascade; adding a third when comments arrive is one migration, and the service and API shape do not change.
4. **The existing `write` limiter bucket, not a new one.** Reacting to four hundred entries in a minute is precisely what a 60-burst / 120-per-minute write bucket is for. A third bucket would be a new Lua path and new configuration for a case the current one already covers.
5. **One palette for now.** The design leaves *what premium contains* open; splitting the set into free and premium tiers would implement an undecided design. The palette is a single exported constant, so a split is a one-line change when the question is answered.
6. **On by default, with a creator toggle.** It is a quality-of-life feature, so opt-out rather than opt-in — but a board that wants no emoji on it is the creator's call.

## Scope

**In:** `Reaction` model over entries and notes; add and remove; counts and the reader's own on the board and the entry page; `CreatorPolicy.allowReactions`.

**Out, with reasons:**
- *Premium palette split* — blocked on the design's open question about premium.
- *Reactions on comments* — comments do not exist yet. The column is added with them.
- *Notifying someone their entry was reacted to* — every entry would generate a stream of them, and the notification list is already the busiest surface in the app.

## File Structure

- `apps/api/prisma/schema.prisma` + migration — `Reaction`, `CreatorPolicy.allowReactions`.
- `apps/api/src/reactions/` — palette, service, controller, module.
- `apps/web/src/components/ReactionBar.tsx` + test.

---

### Task 1: Reacting

- [ ] **Failing tests:** a patron reacts to an entry; the same reaction twice removes it; two different emotes from one person both count; an emote outside the palette is a 400; an entry on another board is a 404; a board with reactions off refuses; the counts come back with the entry; the reader's own reactions are marked.
- [ ] Model + migration with the check constraint.
- [ ] `POST|DELETE /creators/:slug/reactions`, `UPVOTE` capability — reacting is participation, and a board that gates upvoting gates this too.
- [ ] **Mutation-check:** dropping the palette check, dropping the creator scope, and letting a reaction reach an ordering must each fail.
- [ ] Commit.

### Task 2: On the board

- [ ] **Failing tests:** the bar shows each emote with its count; the reader's own are pressed; clicking toggles; a reader who cannot upvote sees counts but cannot react; nothing renders when the board has them off.
- [ ] `ReactionBar`, mounted on the card.
- [ ] e2e: a patron reacts, reloads, and the reaction is still there.
- [ ] Commit.

---

## Known risks

- **A third subject type means a migration**, not just a code change. Accepted in exchange for referential integrity; the alternative loses cascade deletes silently.
- **Counts are unbounded per entry**, so a very popular entry carries a row per person per emote. The palette is small and the rows are narrow, but nothing prunes them.
- **The palette is a shipped constant**, so changing it is a deploy. Reactions already stored under a removed emote would still be counted but not rendered — worth a migration if an emote is ever retired.
