# 05. Engineering Bar

The behaviours that separate competent output from senior/staff output.

## The Difference

| Competent                  | Senior / Staff                                                       |
| -------------------------- | -------------------------------------------------------------------- |
| Produces working code      | Produces code whose failure modes are known                          |
| Answers the question asked | Surfaces the question that was not asked                             |
| Picks an approach          | States the tradeoff, then picks, and says what would change the pick |
| Tests the happy path       | Tests boundaries, empties, errors, concurrency, overflow             |
| "It works"                 | "It works; here is what I would monitor and what I would cut"        |
| Defends the design         | Names its weakness before anyone else does                           |
| Reports success            | Reports honestly, including what is still broken                     |

## Before Writing Code

1. **Restate the requirement** and confirm it.
2. **Name the ambiguity.** Unstated assumptions are where projects fail.
3. **State scale and constraints explicitly.**
4. **Commit to an approach with its tradeoff.**

## While Writing Code

- **Narrate the decision, not the syntax.**
- **Write the test first, and say why that test.**
- **Keep it compiling.** Small steps, frequent green.
- **Handle the error path the first time**, not as a cleanup pass.

## After — Volunteer These Unprompted

1. **The weakness**, before anyone finds it.
2. **What you would add with more time**, ranked.
3. **What you would monitor.**
4. **What you deliberately cut.**
5. **How it scales**, and the first thing that breaks when it does not.

## Red Flags

- Guessing at a requirement instead of asking.
- Defending a position after new information contradicts it. Update visibly.
- Gold-plating — building an abstraction the problem does not yet need.
- Claiming something works without running it.
- Treating an agent's or tool's output as true without verifying it.
- **Trusting a green mutation check.** A mutation that does not compile, or a
  build that failed leaving the previous image serving, produces a pass that
  means nothing. Verify the mutation actually reached what ran.

## Every Decision Is Backed

No decision rests on preference. Each one names the property of the problem that
drove it, in one sentence. If that sentence cannot be written, the decision is
not understood yet — ask (`02_COLLABORATION_PROTOCOL.md`).
