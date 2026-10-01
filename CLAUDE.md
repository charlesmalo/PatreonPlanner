# PatreonPlanner

A standalone project (its own git repo, unrelated to any sibling project in the workspace).

## Tooling

Two spec mechanisms exist here. **Which one to use is not a free choice** — read this before
reaching for either.

- **Superpowers** — user-level Claude Code plugin (brainstorming, test-driven-development,
  systematic-debugging). Active automatically. **This is what built the project**: 3 design docs
  in `docs/superpowers/specs/` and 42 plans in `docs/superpowers/plans/`, covering 139 merged
  PRs from 2026-08-03 onward. Treat those as the historical record of what was built and why.
  They are not updated after the fact, so a plan describes its moment, not today's code.
- **OpenSpec** (`openspec/`, commands under `/opsx:*`, conventions in `openspec/config.yaml`) —
  **the mechanism for new user-facing features from 2026-09-24 onward.** Configured since the
  first commit but unused until then: exactly one change has gone through it
  (`add-redeemable-priority-tokens`, archived 2026-09-28).

  It earned its place immediately. Promoting that change's spec to canonical is what exposed a
  real bug — the spec said disabling the feature makes it invisible, the code only made it
  unspendable, and a board that switched tokens off kept showing Priority badges and patrons'
  notes (fixed in #140). Writing "the system SHALL do X" as a standalone claim invites checking
  it, which is the point.

  **`openspec/specs/` is not a description of this system.** It holds one capability out of
  roughly twenty. Do not read it as complete, and do not let a reader assume it is. The other
  nineteen were never backfilled, deliberately: reconstructing specs for shipped code produces
  authoritative-looking documents nobody validated against reality.

## Agent ruleset — read this first

`coding_agent/` is the **single source of truth** for how any AI coding agent
operates here. Start every session with `coding_agent/00_AGENT_INSTRUCTIONS.md`,
which holds the required reading order and the index to the full ruleset.

The four rules that override everything:

1. **Brainstorm → requirements → plan → implement**, in that order, every task.
   What scales with size is the artifact, never whether the phase happens. If
   something contradicts the plan, **pivot immediately** and say so.
   (`coding_agent/10_WORKFLOW.md`)
2. **Never assume.** Ambiguity becomes a multiple-choice question with a
   recommendation and pros/cons. (`coding_agent/02_COLLABORATION_PROTOCOL.md`)
3. **Never claim done without proof.** Run the verification commands and quote
   their output — and note that `pnpm -r test` does not typecheck.
   (`coding_agent/07_TESTING_STANDARDS.md`)
4. **The engineer decides.** Architectural decisions, new dependencies, and
   out-of-scope changes need approval. This project carries a standing grant for
   commit and push on the current line of work; its limits are recorded in
   `coding_agent/02_COLLABORATION_PROTOCOL.md` §1.

`AGENTS.md` and the other tool pointer files defer here and to `coding_agent/`.
If a rule needs to change, change it in `coding_agent/` first.

## Status

Phase 1 shipped. Phase 2 (board experience) is designed in
`docs/superpowers/specs/2026-08-17-phase2-board-experience-design.md` and is
being built in sequence — see `coding_agent/PROGRESS_TRACKER.md` for exactly
where the work stands and what is blocked.
