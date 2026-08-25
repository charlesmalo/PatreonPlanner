# 09. Debugging Methodology

Applied systematically to every bug, test failure, or unexpected behaviour —
**before** proposing a fix.

Guessing at a fix is the fastest way to produce a coincidental green build that
hides the real defect.

## The 14 Steps

**1. Determine what IS working.** Map the related parts that behave correctly.

**2. Determine precisely what is NOT working.** Catalogue the exact sequence of
events and behaviours that fail.

**3. Simplify the problem.** Reduce reproduction to the absolute minimum.

**4. Generate hypotheses.** Ask: what process would produce _this specific
symptom_?

**5. Test hypotheses by divide and conquer.** Isolate sub-units. Check inputs and
outputs around each to find where behaviour first deviates from expectation.

> **Do not proceed past this step until you are certain what the bug is.**
> Not "fairly confident". Certain.

**6. Consider other versions of this bug class.** Is this a one-off typo or a
symptom of an architectural assumption that could be wrong elsewhere too?

**7. Write regression tests first.** _Before_ fixing, write tests targeting the
bug class. **Confirm they fail against the current code.**

> If a fix is not tested, assume it is broken or will break again.

**8. Fix the root cause.** Driven by the failing tests rather than trial and
error.

**9. Confirm the new tests pass.**

**10. Confirm the simplified case** from step 3 is resolved.

**11. Confirm the original issue** from step 2, including its edge cases.

**12. Document the fix** — the change, the test, and a one-line root cause.

**13. Note other possible bug classes.** File follow-ups; do not fix them now.

**14. Report.** Summarize problem and solution with the verification output.

## Measure Before Concluding

When the symptom is visual or performance-related, **measure it** rather than
reasoning about it. A card that rendered invisibly in this project was diagnosed
by reading its computed box (`width: 0`) — not by guessing at CSS. An index that
looked unused was settled by `EXPLAIN ANALYZE`, not by reading the query.

## Distrust a Passing Reproduction

If a test written to reproduce a bug passes on the first run, the test is wrong
until proven otherwise. Reproduce it outside the suite — a standalone probe
against a real database or a real browser — then rebuild the test around what
actually reproduced.

## Anti-Patterns

| Shortcut                          | Why it fails                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Changing code to see what happens | Produces coincidental green, not understanding                                                   |
| Fixing the symptom                | The bug class survives and returns                                                               |
| Skipping step 7                   | No proof the fix works, or that it stays fixed                                                   |
| Several changes at once           | You cannot attribute which one worked                                                            |
| "It's probably a caching issue"   | A guess dressed as a diagnosis — return to step 5                                                |
| Blaming the framework first       | Almost never the framework. Prove it before claiming it                                          |
| Assuming the environment is fine  | A stack that failed to rebuild, or was never up, fails tests in ways that look like code defects |
