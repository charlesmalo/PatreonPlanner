# 11. Stack Selection

**This project's stack is chosen and locked** (`01_PROJECT_RULES.md`). This file
governs the next new subsystem, service, or tool — not a re-litigation of what
already runs.

## When This Applies

When a piece of work needs something the stack does not already provide: a new
runtime, a new datastore, a new external service, a new test framework.

It does **not** apply to adding a library within the existing stack — that is a
dependency decision (`02_COLLABORATION_PROTOCOL.md` §1).

## What Drives the Choice

| Signal                   | What to look for                                               |
| ------------------------ | -------------------------------------------------------------- |
| **Shape of the work**    | CRUD · pipeline · CLI · UI-heavy · library · real-time · batch |
| **Correctness pressure** | Money, safety, compliance, auditability                        |
| **Scale and traffic**    | Most projects are far smaller than they feel                   |
| **Persistence needs**    | None · file · embedded · relational · document · queue         |
| **Integration surface**  | What must it talk to, and what do those speak natively?        |
| **Team familiarity**     | A first-class input, not an afterthought                       |
| **Lifespan**             | Spike · proof of concept · long-lived                          |
| **Time budget**          | A tight deadline legitimately favours the boring option        |

## The Constraint That Overrides The Rest Here

**Free tooling only** (`01_PROJECT_RULES.md` §2). Before recommending anything
hosted, establish what it costs — including the free tier's real limits.

This has already decided several things in this project, and the reasoning is
worth not repeating from scratch:

- Hosted embedding APIs are out; embeddings run locally on CPU.
- Platform search APIs are out — Netflix has had none since 2014, Crunchyroll has
  none, Amazon's requires affiliate approval, and YouTube's free quota is ~100
  searches per **day across all users combined**.
- Scraping is rejected: it violates terms, breaks without warning, and is the one
  part of this product that could attract a legal letter.

## How to Present the Recommendation

Follow the question format in `02_COLLABORATION_PROTOCOL.md` §2 — options with a
recommendation first and specific pros and cons. For a stack, also cover:

1. **Language and runtime** — and the one property of the problem that drove it
2. **Framework** — or an explicit "no framework", which is often correct
3. **Persistence** — including "none" and "a file on disk"
4. **Test framework and coverage tool**
5. **Formatter and linter** — these get wired before any business logic
6. **What you would use instead if one constraint changed** — this shows the
   choice was reasoned rather than reflexive

## Rules for the Recommendation

- **Boring beats clever.** Novelty is a cost paid by whoever maintains this later.
- **Fewest moving parts that satisfy the requirement.**
- **Say what you would cut.**
- **Name the weakness** of the recommendation before the engineer finds it.
- **Check what the thing actually offers before designing around it.** A design
  resting on a capability that does not exist is worse than no design.

## After Approval

1. Record it in `01_PROJECT_RULES.md`.
2. Record the decision and rejected alternatives in the Key Decisions table in
   `03_ARCHITECTURE_AND_DOCS.md`.
3. **Wire the tooling before any business logic.**
