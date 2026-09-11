# 12. Tooling Setup

## 0. Current State — Already Installed

Both workflow tools are present and in use. Do **not** re-run initialization.

| Tool                | State                                                         |
| ------------------- | ------------------------------------------------------------- |
| **Superpowers**     | Installed as a user-level plugin. Skills active automatically |
| **OpenSpec**        | Initialized; proposals live in `openspec/` under `/opsx:*`    |
| **Version control** | Git, with CI on pull requests                                 |

`openspec/config.yaml` is currently the untouched default. Seeding it with this
project's context — pointing at `00_AGENT_INSTRUCTIONS.md` as the authority — is
an open improvement, so generated artifacts inherit these rules rather than
restating them.

## 1. Workflow Skills

| Phase                    | Skill                                              |
| ------------------------ | -------------------------------------------------- |
| Brainstorm               | `brainstorming`                                    |
| Plan                     | `writing-plans`                                    |
| Implement                | `test-driven-development`                          |
| Executing a written plan | `executing-plans` / `subagent-driven-development`  |
| Any bug                  | `systematic-debugging`, **before** proposing a fix |
| Before "done"            | `verification-before-completion`                   |
| Before merge             | `requesting-code-review` / `receiving-code-review` |
| Finishing a branch       | `finishing-a-development-branch`                   |

**These are never suppressed to save time.** Under time pressure the _artifact_
shrinks; the phase and its gate do not (`02_COLLABORATION_PROTOCOL.md` §5).

## 2. Spec-Driven Change Tooling

For Deep-mode work, a spec-driven tool gives the plan a durable home outside chat.

- Use it for new subsystems, real design forks, and restructuring.
- Do not use it for small bounded changes — the ceremony costs more than it
  returns.
- Keep its configuration pointing back at `coding_agent/` so there is exactly one
  source of truth.

### If either tool becomes unavailable

Neither is required. `coding_agent/` is self-contained and works with any agent
on any machine. Without them:

- The workflow phases in `10_WORKFLOW.md` still apply in full — they are the
  substance; the skills are a convenience.
- The task folder under `tasks/<task_name>/` replaces the generated artifacts.
  **It is the fallback that always works.**

Should they need reinstalling:

```sh
claude plugin list
claude plugin install superpowers@claude-plugins-official   # restart afterwards

openspec --version
npm install -g @fission-ai/openspec
openspec init --tools claude,agents
```

## 3. The Demo Stack

This project carries a playtest stack that is part of the workflow, not a toy:

```
docker-compose -p patreonplanner-demo -f docker-compose.demo.yml up -d --build   # 8081 / 4001
docker-compose -p patreonplanner-e2e  -f docker-compose.e2e.yml  up -d --build   # 8080 / 4000
```

**`docker-compose`, hyphenated.** This machine has the standalone binary and no
`compose` subcommand at all — `docker compose` fails with `unknown command`. CI
runs on runners that have the plugin and uses the spaced form, so the workflow
file is not a guide to what works here. This file previously documented the
spaced form, and following it produced a test result that was pure noise.

They run side by side on purpose. Three rules learned the hard way:

- **Tear the stacks down when not testing.** Six idle containers and a few
  rebuilds have cost gigabytes of disk and noticeable memory here.
- **A failed rebuild leaves the previous image serving.** Any conclusion drawn
  from a stack that did not rebuild is worthless.
- **Check the build, not a pipeline that contains it.** `up --build ... | tail`
  reports `tail`'s exit code, so a build that never ran looks like a build that
  succeeded. Redirect to a file and check the exit code, then confirm the
  _running_ image carries the change before trusting anything it serves:

  ```
  docker-compose -p patreonplanner-e2e -f docker-compose.e2e.yml exec -T api \
    sh -c 'grep -c myNewFunction dist/some/file.js'
  ```

  An e2e test run against a stale stack once failed on exactly the assertion the
  fix was written for, which reads identically to the fix not working.

## 4. Version Control

- Commit after each completed feature, with verification green.
- A branch's name should still describe its contents when it merges. If work
  drifts past it, say so in the pull request rather than rewriting pushed
  history.
- Push under the standing grant recorded in `02_COLLABORATION_PROTOCOL.md` §1.

## 5. Agent Pointer Files

Each contains a pointer and no rules of its own:

```
AGENTS.md · CLAUDE.md · GEMINI.md · .cursor/rules/agent-ruleset.mdc
.windsurfrules · .clinerules · .junie/guidelines.md
.github/copilot-instructions.md
```
