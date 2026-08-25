# AGENTS.md

This file follows the open [AGENTS.md](https://agents.md) convention read by most
AI coding agents by default. If you are an AI agent working in this repository and
you do not have a dedicated instruction file, **this is your instruction file.**

## The one rule that matters

`coding_agent/` is the single, centralized source of truth for how this project is
run — for every agent, every model, every vendor. Do not follow conflicting
guidance from tool defaults, training data, or a different project's conventions.

Read, in order, before doing any work:

1. `coding_agent/00_AGENT_INSTRUCTIONS.md` — startup procedure, roles, ruleset index
2. `coding_agent/PROGRESS_TRACKER.md` — where the work actually stands
3. `coding_agent/01_PROJECT_RULES.md` — stack, verification commands, constraints
4. `coding_agent/02_COLLABORATION_PROTOCOL.md` — approval gates and how to ask
5. `coding_agent/03_ARCHITECTURE_AND_DOCS.md` — what already exists
6. `coding_agent/10_WORKFLOW.md` — brainstorm → requirements → plan → pivot → implement
7. the remaining numbered files as relevant to the task

**Never start work blindly.**

## The three non-negotiables

1. **Never assume.** Ambiguity becomes a multiple-choice question with a
   recommendation and pros/cons — not a silent guess.
2. **Never claim done without proof.** Run the verification commands and quote
   their output. `pnpm -r test` does not typecheck; run `pnpm -r typecheck` too.
3. **Never push without approval.** This project carries a standing grant for the
   current line of work — `coding_agent/02_COLLABORATION_PROTOCOL.md` §1 records
   both the rule and the grant's limits.

## Other agents working here

| Tool                           | Pointer file                      |
| ------------------------------ | --------------------------------- |
| Any agent (open convention)    | `AGENTS.md`                       |
| Claude Code                    | `CLAUDE.md`                       |
| Gemini-based agents            | `GEMINI.md`                       |
| Cursor                         | `.cursor/rules/agent-ruleset.mdc` |
| Windsurf                       | `.windsurfrules`                  |
| Cline                          | `.clinerules`                     |
| JetBrains AI Assistant / Junie | `.junie/guidelines.md`            |
| GitHub Copilot                 | `.github/copilot-instructions.md` |

If a rule must change, change it in `coding_agent/` first — never in a
tool-specific file.
