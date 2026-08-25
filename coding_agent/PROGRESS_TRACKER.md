# Progress Tracker

## Current Status

Phase 1 is complete and merged. Phase 2 — the board experience — is designed in
`docs/superpowers/specs/2026-08-17-phase2-board-experience-design.md` and is
being built in sequence. Ten of its eleven steps have shipped.

The verification baseline at the time of writing: **806 API + 255 web + 37 e2e
tests passing**, typecheck clean across every package.

## Milestones

- [x] M0: Repository scaffolded, tooling wired
- [x] M1: Phase 1 design captured (`docs/superpowers/specs/2026-08-03-...`)
- [x] M2: Auth, capabilities, boards, submissions, de-duplication
- [x] M3: Upvotes, availability, franchises, watch orders, themes
- [x] M4: Abuse scoring, staff invites, creator notes, rate limiting
- [x] M5: Fuzzy + semantic search (local embeddings, RRF fusion)
- [x] M6: Notifications, moderation results, per-creator blocklist
- [x] M7: Playtest demo stack with personas
- [x] M8: Phase 2 design agreed
- [x] M9: Entry detail pages, kanban board, per-column sorting, creator picks
- [x] M10: Weighted voting, the upward-only ratchet, the my-votes page
- [x] M11: Granular moderator permissions, view-as mode
- [x] M12: Disputes and contact tickets
- [x] M13: Grouping (the link/candidate model is its own plan, not yet started)
- [x] M14: Reactions
- [ ] M16: Drag-and-drop
- [x] M15: Donation page (link-out; needs a payment URL to switch on)

## Active Task

None. Grouping shipped, which was the last blocked item. What remains is
drag-and-drop and the link/candidate model (design §4), neither blocked.

## Open Questions Blocking Work

| Question                                                       | Blocks | Why it matters                                                                     |
| -------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| Does a group's weight sum its children, or show only the head? | M13    | Weight is now a real number rather than a headcount, so the answer changes ranking |
| What does premium contain beyond the reaction palette?         | M14    | It may withhold no functionality and may not override a creator's limits           |
| Which permissions stay bundled under `MODERATE`?               | —      | The five that exist cover today's endpoints                                        |

## Known Debt

- **Coverage is not wired.** `07_TESTING_STANDARDS.md` §3 states the target and
  why it is not yet a gate.
- **`recommendations.service.ts` is well past the 300-line limit**
  (`04_CODE_STANDARDS.md` §1). Splitting it needs its own approval.
- **The `ThemeSource` migration is not rolling-deploy safe** — backfill and
  `DROP COLUMN` in one step. Harmless with nothing deployed; must be split into
  expand/contract before this ever runs more than one instance.
- **`openspec/config.yaml` is the untouched default**, so generated artifacts do
  not inherit these rules.

## Session Log

| Date       | Event                                                       |
| ---------- | ----------------------------------------------------------- |
| 2026-08-24 | `coding_agent/` ruleset added to an already-running project |
