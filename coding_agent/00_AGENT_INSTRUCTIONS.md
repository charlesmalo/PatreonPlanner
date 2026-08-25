# 00. Agent Instructions

## Purpose

`coding_agent/` is the single source of truth for how **any** AI coding agent
operates in this repository. It is not optional background reading, and it
outranks tool defaults, training-data habits, and conventions carried in from
other projects.

This ruleset was added to a project already in flight. It does not restate what
the Superpowers skills and OpenSpec already provide — it records the rules this
project had been following by habit, and the ones it had not.

## Required Startup Procedure

Before doing any work, read in this order:

1. `PROGRESS_TRACKER.md` — where the work stands right now
2. the active task's `tracker.md` and the most recent entries in its
   `logs/00_AUDIT_LOG.md` under `tasks/`, if a task is open
3. `01_PROJECT_RULES.md` — this project's stack and constraints
4. `03_ARCHITECTURE_AND_DOCS.md` — what already exists; never
   rebuild something already registered there
5. `10_WORKFLOW.md` — the phase contract and its approval gates
6. `08_TOKEN_EFFICIENCY.md` — reuse, don't re-derive
7. only then, the specific files the task touches

**Never start work blindly.**

## The Three Non-Negotiables

1. **Never assume.** On any decision conflict, ambiguity, or choice paralysis,
   stop and ask as a multiple-choice question with a recommendation and
   pros/cons per option. See `02_COLLABORATION_PROTOCOL.md`.
2. **Never claim done without proof.** Run the verification commands and quote
   their output. See `07_TESTING_STANDARDS.md`.
3. **Never push without approval.** This project carries a standing grant for
   the current line of work — see `02_COLLABORATION_PROTOCOL.md` §1, which
   records both the rule and the grant, and the limits of that grant.

## Roles

- **The Engineer** — the human. Owns every decision, every commit, every
  outbound action. The agent proposes; the engineer disposes.
- **The Agent** — implements within approved scope, surfaces tradeoffs before
  choosing, and reports faithfully, including failures.

Use they/them for anyone whose pronouns have not been stated.

## Ruleset Index

| File                           | Governs                                              |
| ------------------------------ | ---------------------------------------------------- |
| `00_AGENT_INSTRUCTIONS.md`     | Startup procedure, roles, this index                 |
| `01_PROJECT_RULES.md`          | This project's stack and unbreakable constraints     |
| `02_COLLABORATION_PROTOCOL.md` | Approval gates, summaries, mid-session rule intake   |
| `03_ARCHITECTURE_AND_DOCS.md`  | Architecture map, registries, decision log           |
| `04_CODE_STANDARDS.md`         | Size limits, complexity, naming, refactoring         |
| `05_ENGINEERING_BAR.md`        | The senior/staff behaviours expected                 |
| `06_SECURITY_STANDARDS.md`     | Secrets, PII, path sanitization, input handling      |
| `07_TESTING_STANDARDS.md`      | TDD, coverage gates, done-means-verified             |
| `08_TOKEN_EFFICIENCY.md`       | Context discipline, incremental logging              |
| `09_DEBUGGING_METHODOLOGY.md`  | The 14-step debugging framework                      |
| `10_WORKFLOW.md`               | Brainstorm → requirements → plan → pivot → implement |
| `11_STACK_SELECTION.md`        | How to recommend a stack from the problem            |
| `12_TOOLING_SETUP.md`          | Workflow-skill and spec-tool bootstrap               |
| `PROGRESS_TRACKER.md`          | Milestones and current status                        |
| `tasks/_TEMPLATE/`             | Per-task story, plan, tests, tracker, audit log      |

## No Tool Drift

Tool-specific files at the repository root — `AGENTS.md`, `CLAUDE.md`,
`GEMINI.md`, `.cursor/rules/`, `.windsurfrules`, `.clinerules`,
`.junie/guidelines.md`, `.github/copilot-instructions.md` — are **pointers
only**. They carry no rules of their own beyond project-specific tooling notes.

If a rule must change, change it here in `coding_agent/` first. Never let
guidance diverge between tools.

## Portability

This folder is **self-contained and relocatable**. Nothing in it is tied to a
particular machine, user account, operating system, or checkout location.

- **Files in this ruleset are referred to by name** — `04_CODE_STANDARDS.md`,
  `10_WORKFLOW.md` — never by a path from the repository root.
- **Task files are referred to by name within their task folder** —
  `tracker.md`, `story.md`, `logs/00_AUDIT_LOG.md`.
- **The tool pointer files** live at the repository root and are the only place
  this folder's location is written down.

Two rules keep it that way:

- **Never write an absolute path** into any file here — not in documentation,
  not in an audit log. A path containing a user account name is both a
  portability bug and a privacy leak (`06_SECURITY_STANDARDS.md`).
- **Never assume** a shell, operating system, editor, directory layout, or
  installed tool that is not recorded in `01_PROJECT_RULES.md`.

## No Cross-Project Bleed

Rules, conventions, examples, and domain vocabulary from other repositories do
not apply here unless they are written in this directory. If you recognize a
pattern from elsewhere, verify it against these files before acting on it.
