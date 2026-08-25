# 07. Testing Standards

## 1. Done Means Verified

**No task is claimed complete, fixed, or passing until the verification commands
have been run and their output confirms it.** Evidence before assertions.

Forbidden without a fresh successful run in the current session:

> "done" · "fixed" · "working" · "should work" · "that passes now"

Required form — state the command, state the observed result:

> `pnpm -r test` → 762 API + 235 web passing. `pnpm -r typecheck` → clean.

**`pnpm -r test` transpiles without typechecking.** A green test run has passed
a broken build in this project before. Run `pnpm -r typecheck` too, always.

If verification fails, say so immediately with the actual output. A red build
reported honestly is worth more than a green claim that is not true.

## 2. Test-Driven by Default

1. **Red** — write the failing test; run it; confirm it fails **for the right
   reason**. A test that passes before the implementation exists is testing
   nothing.
2. **Green** — the simplest implementation that passes.
3. **Refactor** — clean up with tests green and behaviour unchanged.

Bug fixes follow the same loop: the regression test is written first and must
fail against the current code before the fix lands
(`09_DEBUGGING_METHODOLOGY.md`).

## 3. Coverage Gates

| Metric          | Target |
| --------------- | ------ |
| Line coverage   | ≥ 90%  |
| Branch coverage | ≥ 75%  |

**Not currently wired.** No coverage tool is configured
(`01_PROJECT_RULES.md`), so these are a target rather than an enforced gate.
Wiring them is a decision for the engineer, and a gate added now would be
negotiated against existing violations — which is how gates die.

Until then, coverage is judged by the mutation discipline in §7, which asks a
stronger question than a percentage does.

**Never lower a threshold to make a build pass.**

## 4. Both Levels, Where Each Applies

**Unit tests** — fast, isolated, no framework context. Pure logic — the access
resolvers above all — is tested here, without a database.

**Integration tests** — real Postgres via Testcontainers, narrowest useful slice.
Boundaries: HTTP handlers, persistence, adapters. Assert status, payload shape,
validation failures, and persistence behaviour.

**End-to-end** — Playwright against the real Docker stack with the real proxy.
The failures this catches — route prefixes, cookie scope, proxy paths, a bundle
that failed to build — exist only in that arrangement.

**Composition guard.** Unit tests cannot see a system wired wrong: every part can
be correct while the assembled whole is broken.

## 5. What a Good Test Asserts

- **Boundaries, not the happy path**: zero, one, empty, null, negative, maximum,
  off-by-one, duplicate.
- **Error paths explicitly.**
- **One behaviour per test.**
- **Named as a sentence** describing the behaviour.
- **No logic in tests** — no loops, no conditionals.
- **Deterministic.** No wall clock, no randomness, no ordering assumptions.
- **Independent.** No test may depend on another having run first, or on state a
  sibling left behind.

### Shared browser state is where independence breaks

`localStorage` has leaked between tests in this project **twice** — once through
favourites, once through the view mode. Any suite touching a component that
persists a reader's choice clears it in `afterEach`.

## 6. A Test Must Fail For Its Own Reason

A test whose fixture cannot produce the failure it names proves nothing.

Two real examples from this project:

- A tenancy test whose "outsider" had no staff row **on any board** passed with
  the `creatorId` filter deleted, because an unscoped query returned nothing for
  them either. The fixture must be someone who _would_ be returned by the bug.
- A rollback test that threw _inside_ the transaction passed for an
  implementation that emitted _after_ it — because that implementation never ran
  at all. The test had to ask the transaction what it could see.

Before writing a test, name the production change that would make it fail. If
that change is "delete the whole feature", the test is too weak.

## 7. Mutation Discipline

For any rule with teeth — authorization, visibility, ordering, tenancy — revert
the rule and confirm a test fails. A rule nothing tests is a rule that will be
removed by accident.

**Verify the mutation actually reached what ran.** Three ways this has silently
produced a false pass here:

- The patch did not apply, and the "no failures" output was read as a pass.
- The mutation broke the typecheck, so the Docker build failed and the **old
  container kept serving** — the suite ran against unmutated code.
- The harness swallowed the runner's output, so the absence of a failure line
  looked like success.

Check the exit code, and for a built artifact check the artifact changed.

## 8. No Redundancy in Tests

- Shared fixtures and builders live in test support modules.
- If an integration test covers a path exactly, scope the unit test to the edge
  case or remove it.
