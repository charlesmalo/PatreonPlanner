# Weighted Voting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** An upvote counts for what the voter's tier is worth, so the board ranks by support rather than by headcount alone.

**Architecture:** A vote records the tier it was cast at. The board keeps a denormalised weighted score alongside the headcount it already keeps, both maintained in the vote's own transaction.

## A correction to the design doc

The Phase 2 design says to store per-tier **counts** and compute `Σ count × weight` on read, so that a creator rebalancing weights needs no backfill. That reasoning holds only while the weight is something you *display*.

It is also the board's **primary sort key**, and the board pages by keyset. A keyset cursor cannot order by a sum computed after the query returns — the comparison has to be a column the database can order and compare. So the weighted score is stored, exactly as `upvoteCount` already is, and a rebalance recomputes it.

That recompute is bounded and rare: one creator's rows, triggered by an explicit admin action, from a `GROUP BY tierId` rather than a walk of every vote. The doc's concern — a cache silently disagreeing with the tiers — is answered by making the recompute part of the same transaction as the weight change, not by avoiding the column.

## Decisions this plan settles

1. **A vote stores its tier**, never a copied number. A creator rebalancing changes what every existing vote is worth, which is the point; copying the number at vote time would freeze the board against its own settings.
2. **No tier means weight 1.** A board that lets non-patrons upvote is letting them vote, and a person is a person. Zero would mean the vote does not count at all, which contradicts a functional feature being free — free is handled by the `UPVOTE` capability, not by a weight of nothing.
3. **Both numbers are shown.** "210 points" hides whether that is forty people or three, and those are different signals for a creator deciding what to watch.
4. **Weights are `ADMINISTER`.** What a tier is worth is board policy, next to the paywall — not day-to-day curation.
5. **The ratchet and the my-votes page are not in this plan.** They are a voluntary action on top of a working feature; the core has to exist first.

## Scope

**In:** `Tier.voteWeight`; `Upvote.tierId`; `Recommendation.weightedScore` maintained transactionally; sorting and paging on it; recompute when weights change; both numbers on the card.

**Out:** the upward-only ratchet, the my-votes page, manual ordering.

---

### Task 1: A tier is worth something

- [ ] **Failing tests:** default weight is 1; an owner sets weights; a moderator cannot; a weight below zero is refused; weights are per board.
- [ ] `Tier.voteWeight Int @default(1)` + migration.
- [ ] `PATCH /creators/:slug/tiers/:id` with `{ voteWeight }`, `ADMINISTER`, scoped by creator.
- [ ] Commit.

### Task 2: A vote carries its tier

- [ ] **Failing tests:** a vote records the voter's current tier; a voter with no tier still counts 1; the weighted score follows the tiers; removing a vote removes its weight; the board sorts by weight, not headcount; both numbers are returned.
- [ ] `Upvote.tierId String?` and `Recommendation.weightedScore Int @default(0)` + migration backfilling `weightedScore = upvoteCount` (every existing vote is worth 1 until a creator says otherwise).
- [ ] `toggleUpvote` resolves the voter's tier for this creator and moves both counters in the transaction it already uses.
- [ ] Board ordering and cursor move from `upvoteCount` to `weightedScore`; `upvoteCount` stays as the headcount.
- [ ] **Mutation-check:** ordering by headcount again, and forgetting the tier on a vote, must each fail.
- [ ] Commit.

### Task 3: A rebalance reaches the board

- [ ] **Failing tests:** raising a tier's weight raises the score of entries its patrons voted for; lowering it lowers them; another board is untouched.
- [ ] Recompute inside the weight-change transaction, from `GROUP BY tierId` over that creator's votes.
- [ ] **Mutation-check:** skipping the recompute must fail.
- [ ] Commit.

---

## Known risks

- **A rebalance is O(entries) for that creator.** Fine at any plausible board size, and it happens when someone edits a setting — but it is a write amplification worth remembering if boards ever get very large.
- **The score and the votes can drift** if a future writer touches `Upvote` outside `toggleUpvote`. The recompute is the repair, but nothing detects the drift on its own.
- **Weight is invisible to the voter** until the my-votes page exists; a patron cannot yet see what their vote was worth.
