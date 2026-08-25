# PatreonPlanner

A standalone project (its own git repo, unrelated to any sibling project in the workspace).

## Tooling

- **OpenSpec** (spec-driven workflow) — configured for Claude Code. Change proposals live in
  `openspec/`. Commands are available under `/opsx:*` (e.g. `/opsx:propose "idea"`,
  `/opsx:apply`, `/opsx:archive`). Project context/conventions go in `openspec/config.yaml`.
- **Superpowers** — user-level Claude Code plugin providing workflow skills (brainstorming,
  test-driven-development, systematic-debugging, etc.). Active automatically.

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
