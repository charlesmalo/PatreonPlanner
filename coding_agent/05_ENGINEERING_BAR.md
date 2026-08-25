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

1. **Restate the requirement** and confirm it. Catching a misunderstanding here
   is worth more than any code written after it.
2. **Name the ambiguity.** "Are amounts always positive? What is the expected
   volume?" Unstated assumptions are where projects fail.
3. **State scale and constraints explicitly.** "Assuming a single instance and
   thousands of records — at millions I would push this to the database."
4. **Commit to an approach with its tradeoff.** "Starting with an in-memory
   store so we can iterate; swapping in real persistence is a one-module change
   because the logic depends on the interface."

## While Writing Code

- **Narrate the decision, not the syntax.** Explain why a type is immutable, not
  that you are typing a keyword.
- **Write the test first, and say why that test.** "This pins the boundary at
  zero, which is where I would expect an off-by-one."
- **Keep it compiling.** Small steps, frequent green. Never leave the build red
  across a long stretch of work.
- **Model the domain in types** rather than passing primitives around.
- **Handle the error path the first time**, not as a cleanup pass.

## After — Volunteer These Unprompted

1. **The weakness.** "Validation is currently spread across two layers; I would
   consolidate it into the core before this goes to production."
2. **What you would add with more time**, ranked. Shows judgement about priority.
3. **What you would monitor.** Latency, error rate, and the one domain metric
   that reveals breakage before a user reports it.
4. **What you deliberately cut.** Naming the resisted over-engineering is a
   strong signal.
5. **How it scales**, and the first thing that breaks when it does not.

## Red Flags

- Guessing at a requirement instead of asking.
- Defending a position after new information contradicts it. Update visibly.
- Gold-plating — building an abstraction the problem does not yet need.
- Claiming something works without running it.
- Silence while thinking. Say "let me think for a moment" instead.
- Repeated apologizing. Correct, continue, do not dwell.
- Treating an agent's or tool's output as true without verifying it.
- **Trusting a green mutation check.** A mutation that does not compile, or a
  build that failed leaving the previous image serving, produces a pass that
  means nothing. Verify the mutation actually reached what ran.

## Every Decision Is Backed

No decision rests on preference. Each one names the property of the problem that
drove it, in one sentence. If that sentence cannot be written, the decision is
not understood yet — ask (`02_COLLABORATION_PROTOCOL.md`).
