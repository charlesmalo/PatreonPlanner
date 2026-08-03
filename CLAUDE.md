# PatreonPlanner

A standalone project (its own git repo, unrelated to any sibling project in the workspace).

## Tooling

- **OpenSpec** (spec-driven workflow) — configured for Claude Code. Change proposals live in
  `openspec/`. Commands are available under `/opsx:*` (e.g. `/opsx:propose "idea"`,
  `/opsx:apply`, `/opsx:archive`). Project context/conventions go in `openspec/config.yaml`.
- **Superpowers** — user-level Claude Code plugin providing workflow skills (brainstorming,
  test-driven-development, systematic-debugging, etc.). Active automatically.

## Status

Project scaffolding only. The product itself has not been designed yet — start with the
brainstorming skill / `/opsx:propose` to define what PatreonPlanner does before writing code.
