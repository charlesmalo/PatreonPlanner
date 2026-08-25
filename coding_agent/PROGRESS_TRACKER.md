# Progress Tracker

## Current Status

Phase 1 is complete and merged. Phase 2 — the board experience — is designed in
`docs/superpowers/specs/2026-08-17-phase2-board-experience-design.md` and is
being built in sequence. Every sequenced step has shipped, including the
link/candidate model (design §4), which was split out of grouping rather than
dropped.

The verification baseline at the time of writing: **840 API + 279 web + 38 e2e
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
- [x] M13: Grouping
- [x] M14: Reactions
- [x] M16: Drag-and-drop, and hand-arranged order
- [x] M15: Donation page (link-out; needs a payment URL to switch on)
- [x] M17: Link candidates — a submitted link waits for staff, and staff decide
      on the card (plans 09 and 10)

## Active Task

Working down `Known Debt` below. The Phase 2 sequence is complete and nothing
in the design is left unbuilt.

## Open Questions Blocking Work

| Question                                               | Blocks | Why it matters                                                           |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------------------ |
| What does premium contain beyond the reaction palette? | M14    | It may withhold no functionality and may not override a creator's limits |
| Which permissions stay bundled under `MODERATE`?       | —      | The five that exist cover today's endpoints                              |

## Known Debt

- **Web coverage is not wired.** The API gate is live (`cd apps/api && pnpm
coverage`); vitest needs `@vitest/coverage-v8`, a new dependency and so the
  engineer's call.
- **`recommendations.service.ts` is well past the 300-line limit**
  (`04_CODE_STANDARDS.md` §1). Splitting it needs its own approval.
- **Two migrations are not rolling-deploy safe** — `ThemeSource` (backfill then
  `DROP COLUMN`) and `link_candidates` (backfill then `SET NOT NULL`), each in
  one step. Harmless with nothing deployed, and deliberately _not_ fixed in
  place: Prisma checksums an applied migration, so editing one fails every
  database that already ran it. Both are listed as exemptions in
  `apps/api/test/migration-safety.e2e-spec.ts`, which now fails any _new_
  migration that does the same.

## Session Log

| Date       | Event                                                       |
| ---------- | ----------------------------------------------------------- |
| 2026-08-24 | `coding_agent/` ruleset added to an already-running project |
