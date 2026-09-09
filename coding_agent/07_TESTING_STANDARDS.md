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

**And `pnpm format:check`.** CI gates on it and this file did not name it, so the
verification routine described here was smaller than the one that actually
decides. A branch was pushed with every test and typecheck green and failed on two
files edited without prettier afterwards — formatted from memory rather than from
the command. Run all three before pushing; `format:check` covers the whole
repository, so it does not depend on remembering which files were touched.

If verification fails, say so immediately with the actual output. A red build
reported honestly is worth more than a green claim that is not true.

### Playwright: half the assertions do not wait

`expect(locator).toBeVisible()` retries. `locator.count()`, `.isVisible()`,
`.innerText()`, `.allInnerTexts()` and `.allTextContents()` **do not** — they answer
about the page as it is at that instant, which on a page still fetching is "not
there" and "empty".

This has produced four false bug reports in this project, each one costing an
investigation into working code: a settings page reported as stuck loading, a board
reported as hiding the suggestion box from a patron who qualified, a claim page
reported as blank, and an owner reported as unable to see the Themes link. Every
time the app was correct and the check was early.

Before any non-retrying read, wait for something on the page with `expect(…)`
first — a heading is usually enough. And prefer the retrying form:
`await expect(locator).toHaveCount(0)` says the same thing as `count() === 0` and
waits.

The cost is worse than a flaky test, because it points the investigation at the
wrong thing. One of these nearly went into the demo walkthrough as a stated fact.

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

| Metric             | Gate  | Actual at wiring |
| ------------------ | ----- | ---------------- |
| Line coverage      | ≥ 90% | 97.3%            |
| Branch coverage    | ≥ 75% | 87.8%            |
| Statement coverage | ≥ 90% | 96.7%            |
| Function coverage  | ≥ 90% | 98.1%            |

**Wired for the API**: `cd apps/api && pnpm coverage`. Jest's own coverage, so
no dependency was added. Thresholds live in `jest-e2e.json`.

The gate is set at the _target_, not at today's number. A threshold pinned to
current coverage fails on the first honest refactor and teaches everyone to
raise it by hand; one pinned to the standard says what the standard says, and
the headroom above it is where ordinary work happens.

This was previously unwired on the argument that a gate added late is
negotiated against existing violations — which is how gates die. That argument
expired when the numbers were finally measured: every one already cleared its
target, so there was nothing to negotiate. Verified to fail for its own reason
by raising the line threshold to 99.9%, which exits 1 with all tests still
passing.

`main.ts`, `*.module.ts` and DTOs are excluded: they are wiring and shape
declarations, and covering them measures that the app boots, which every
integration test already proves.

**The web side is not wired.** Vitest needs `@vitest/coverage-v8`, a new
dependency — the engineer's decision (`01_PROJECT_RULES.md` §4), not an
agent's.

A percentage is still the weaker question. Coverage says a line ran; the
mutation discipline in §7 asks whether anything would have noticed if it ran
wrong.

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

## 6a. Never Read Async UI With a Call That Does Not Retry

In Playwright and RTL, `expect(...)` retries and a plain read does not. A read taken while a
refetch is in flight returns the empty state, and the test then does something meaningless with
it — quietly, and only sometimes.

```ts
// Wrong: races the refetch the sort change triggered.
await column.getByLabel(/sort/i).selectOption('manual');
const before = await column.getByRole('heading').allTextContents();

// Right: wait for the list, then read it.
const cards = column.getByRole('heading');
await expect(cards).toHaveCount(2);
const before = await cards.allTextContents();
```

This has cost this project twice. Both times the symptom pointed somewhere else entirely — once a
column count that read `0`, once a `filter({ hasText: undefined })` that matched everything and
surfaced as a strict-mode violation on an unrelated drag. **Neither looked like a timing bug**,
and a flake that only fails one run in three is one CI `retries: 1` will hide completely.

**`findBy` only helps if the thing you wait for is the thing that arrives late.** Awaiting an
element that renders regardless of the data is a non-retrying read wearing a disguise — it
resolves immediately and the synchronous read after it still races the request.

```ts
// Wrong: the button renders whether or not the options have loaded, so this waits for nothing.
const send = await screen.findByRole('button', { name: /send/i });
await userEvent.click(screen.getByRole('checkbox', { name: /Perfect Blue/ }));

// Right: wait on the thing that only exists once the data does.
const source = await screen.findByRole('checkbox', { name: /Perfect Blue/ });
const send = screen.getByRole('button', { name: /send/i });
```

This one passed locally and failed on CI, which is the signature: the mock resolves inside the
same microtask batch on an idle machine and does not on a loaded one. Reproduce it by adding a
`setTimeout` to the mock — if the test fails with a delay, it was always broken.

**A component that renders its shell around an empty list invites this**, and it is usually a
product bug too: "you have not suggested anything yet" and "still looking" are different claims,
and showing the first while the second is true tells the reader something untrue. Gate on a
loading state and the whole class disappears.

**A test that grants state must take it back.** The end-to-end database is not rebuilt between
runs — `seedCreator` clears recommendations, not users — so anything written to a `User` row
outlives the run that wrote it. A test granting premium and not clearing it passes on a fresh
database and fails on every run afterwards, which is the worst shape of failure available: the
first thing anybody does with a failing test is re-run it, and re-running is what keeps it broken.

Reset it in `beforeEach` rather than at the end of the test that set it, so a test that fails
half-way does not poison the next one.

**Verify by running the suite twice in a row.** Once proves nothing about state that leaks between
runs, and this is the second time that class of bug has reached a commit here.

If a test is intermittent, suspect a non-retrying read before suspecting the browser.

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
