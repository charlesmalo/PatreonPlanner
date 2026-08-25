# 10. Workflow

Every piece of work moves through the same phases in the same order. **No phase
is ever skipped.** What scales with the size of the task is the _artifact each
phase produces_ — never whether the phase happens.

```
Brainstorm → Requirements → Plan → [Pivot?] → Implement → Verify → Repeat
     ↑                                  │
     └──────────────────────────────────┘
```

These phases map onto the Superpowers skills already installed
(`12_TOOLING_SETUP.md`). Use the skill; this file is the contract it serves.

## Phase 1 — Brainstorm

- Restate the request in your own words and confirm it.
- Name the ambiguities out loud rather than resolving them silently.
- Propose 2–3 approaches with tradeoffs and a recommendation.

**Ends with:** an approved approach.

## Phase 2 — Requirements

- Capture the requirement in the requester's own words.
- List every ambiguity with its resolved answer, or an explicit assumption.
- Write the **non-goals** — what is deliberately not being built, and why.

**Ends with:** requirements the engineer recognizes as correct.

## Phase 3 — Plan

- Each step names the test that proves it, before naming the code that does it.
- Order steps so the build is green at every boundary between them.
- **State the known weakness of the plan before anyone else finds it.**
- Record why this approach beat the alternatives.

**Ends with:** an approved plan.

### The plan is a document that outlives the task

For anything larger than a bounded change, the plan lives in
`docs/superpowers/plans/YYYY-MM-DD-<name>.md` and carries:

- **Decisions this plan settles** — each with the property of the problem behind it
- **Scope**, with reasoned deferrals rather than a bare "out of scope"
- **Known risks**, named before implementation
- **Found in review (fixed)** — added after review, recording what was wrong

That last section is the most valuable part of the file. It is how a defect
found once stops being made twice.

### A plan can be wrong

**When implementation shows the plan was wrong, correct the plan and say so.**
Twice in this project a plan's central claim did not survive contact — a
transaction described as sufficient for isolation, and per-tier counts described
as avoidable backfill. Both were corrected in the plan file with the reasoning,
not quietly worked around.

## Phase 4 — Pivot (whenever reality disagrees)

The moment something contradicts the plan — **stop and say so immediately.**

- Do not push through a plan you now know is wrong.
- Do not quietly adjust scope to make the plan survive.
- State what changed, what it invalidates, and what you propose instead.
- Re-enter the phase the change actually invalidates.

**The ratchet is one-way.** Discovering hidden complexity always moves you back
a phase or up in rigour. Nothing ever moves down mid-task.

## Phase 5 — Implement

- Test-first: red → green → refactor. Confirm the test fails **for the right
  reason** before writing the implementation.
- One behaviour at a time. Keep the build green between steps.
- Refactor as a separate step from behaviour change.

## Phase 6 — Verify

- Run the verification commands. Quote their output.
- **Mutation-check anything with teeth** (`07_TESTING_STANDARDS.md` §7).
- Request review before merging anything non-trivial.
- Update `03_ARCHITECTURE_AND_DOCS.md` with any new utility, type, or boundary.
- Only then may the work be described as done.

## Repeat

Each new feature, bug, or unknown starts again at Phase 1. A previous approval
covers only the work it was given for.

## Task Folders

Any multi-step work may get a folder copied from `tasks/_TEMPLATE/`:

```
coding_agent/tasks/<task_name>/
├── story.md                 the goal and requirements, in the requester's terms
├── implementation_plan.md   the approved design, written before execution
├── tests.md                 expected test cases, written before implementation
├── tracker.md               granular definition-of-done checklist
└── logs/00_AUDIT_LOG.md     dated decisions, why they were made, corrections
```

If a session is interrupted, the next agent resumes from these files instead of
re-deriving everything.

**In this project the plan under `docs/superpowers/plans/` has been serving that
role**, and serving it well — it survives the branch and carries the review
findings. Use a task folder when work spans sessions and needs a live checklist;
use the plan document when the durable record is what matters. Do not maintain
both for the same work.

## Review Is Part Of The Loop, Not A Formality

The reviewer's findings are checked against the code rather than implemented on
sight, and a finding that is wrong is pushed back on with reasoning. In this
project a reviewer has been right about a real data-loss race and wrong about a
test being vacuous, in the same review.

**Most defects found in review here were defects in a plan, or gaps in a test —
not coding errors.** Green tests routinely said nothing about the property they
were named for. Weight review accordingly.

## Two Speeds, Same Gates

|                   | **Fast** (default)                | **Deep** (invoked)                               |
| ----------------- | --------------------------------- | ------------------------------------------------ |
| When              | A change to something that exists | New subsystem, a real design fork, restructuring |
| Brainstorm output | 2–3 sentences, in chat            | Approaches compared; design document             |
| Plan output       | 3–6 bullet steps, in chat         | Written plan under `docs/superpowers/plans/`     |
| **Gates**         | **All of them, always**           | **All of them, always**                          |

## Defensible Decisions

Every technical decision names **why this over the alternatives**, grounded in a
property of the problem — never in preference. If that reason cannot be written
in one sentence, the decision is not yet understood well enough to make.
