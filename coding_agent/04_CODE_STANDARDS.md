# 04. Code Standards

## 1. Size Limits

| Unit              | Limit              | On breach                               |
| ----------------- | ------------------ | --------------------------------------- |
| File              | 300 lines          | Split into encapsulated modules         |
| Class / module    | 200 lines          | Decompose into composable units         |
| Function / method | 50 lines           | Extract helpers                         |
| Parameters        | 5                  | Introduce a parameter object            |
| Nesting depth     | 3                  | Guard clauses, early return, extraction |
| Line length       | 100 soft, 120 hard | Wrap across lines                       |

A file growing past its limit is a signal it is doing too much. It is also
practical: smaller, focused files are easier for both humans and agents to reason
about and edit reliably.

**Test files are judged differently.** A spec listing forty cases is long
because the behaviour has forty cases, not because the file does too much.
Split one when its cases stop sharing a subject, not when it crosses a number.

**No file is over the limit.** The two that were are worth recording, because
the reasoning that kept them stood for one of them and not the other.

| File                        | Was | Now | What actually separated                                                                                             |
| --------------------------- | --- | --- | ------------------------------------------------------------------------------------------------------------------- |
| `components/SubmitForm.tsx` | 378 | 249 | The rules and the markup, not the state: `submit-payload.ts`, `submit-error-message.ts`, `CatalogueSearchField.tsx` |
| `routes/ReviewQueue.tsx`    | 345 | 200 | Two components that were already independent: `FlagActions.tsx`, `RedactForm.tsx`                                   |

The old note said splitting `SubmitForm` would lift fourteen pieces of state
into a parent and move the size rather than remove it. That was **right about
splitting it by mode** — `customTitle` is shared between the two, so a mode
split duplicates a field or lifts it — and **wrong that no split existed**. What
left was the part with rules in it (which payload, what counts as a valid watch
order) and one block of markup. No state moved anywhere.

The note also said `ReviewQueue` stood for "the same reasoning", and that was
simply not so: it already held four components sharing nothing but props, and
two of them lifted out untouched.

The lesson is the one in the rule above — split where the subject changes. The
mistake was reading "this file resists the obvious split" as "this file resists
splitting".

Both refactors are proven by their tests passing **unedited**: 22 for
`SubmitForm`, all of `ReviewQueue`'s. The one test added afterwards covers a bug
the extraction exposed rather than the extraction itself.

`apps/api/src/recommendations/recommendations.service.ts` was the standing
breach at 1061 lines and is now 298 — see plan 11.

## 2. Single Responsibility

A unit does exactly one thing. **If describing it requires the word "and", split
it.** A function named `validateAndSave` is two functions.

## 3. Naming

- Use TypeScript's idiomatic casing consistently.
- **Booleans** read as assertions: prefixed `is`, `has`, `should`, or `can`.
  Never a bare noun.
- **No abbreviations** except universally understood ones (`id`, `url`, `db`).
- **No type-marker affixes** — no `I`-prefixed interfaces, no `-Impl` suffixes.
- **Tests read as sentences** describing the behaviour, not the method called.
- Names describe purpose, not mechanism.

## 4. No Redundancy

- **Rule of two.** Logic written a second time is extracted immediately.
- **No duplicated test setup.** Shared fixtures and builders live in test support
  modules. Never copy-paste an arrange block.
- **No overlapping tests.** If an integration test covers a path exactly, scope
  the unit test to the edge case or delete it.
- **Check `03_ARCHITECTURE_AND_DOCS.md` before writing any utility.**

## 5. Clean Refactoring

- Refactor in a **separate step from behaviour change**, never the same commit.
- **Never refactor outside approved scope.** Note the smell, propose it, wait.
- **Prefer deleting over abstracting.** The cleanest refactor removes code.
- **No speculative generality.** No interface with one implementation, no
  extension point without a second caller.

## 6. Design for Isolation

- Each unit has one clear purpose and can be understood and tested independently.
- Can someone understand it without reading its internals? Can the internals
  change without breaking callers? If not, the boundary is wrong.
- **Dependencies point inward.** The access resolvers depend on nothing.

## 7. Correctness Idioms

- **Model the domain in types, not primitives.**
- **Prefer immutability.** Mutable shared state is where concurrency bugs live.
- **Validate at the boundary, then trust the type inside.**
- **Errors carry context.** A message naming the offending value beats a bare
  type. Never swallow an error silently.
- **A stored reference beats a copied value** when the thing it points at may
  change and the change should propagate — `Upvote.tierId` over a copied weight.
- **Derive an ordering and its keyset from one place.** They must agree; a
  comparison built for one direction pages the other way silently, and nothing
  errors.

## 8. Comments

Code explains _what_; comments explain _why_. A comment restating the code is
deleted. Prefer a comment that records the failure a line prevents — this
codebase's most valuable comments name the bug that made the rule necessary.
Never leave commented-out code.

## 9. Enforcement

Linter rules are not bypassed. Adding a suppression to make a build pass requires
explicit, documented approval, recorded in the audit log with its justification.

## 10. Inclusive Language

Use `allowlist`/`blocklist`, `primary`/`replica`, `main` as the default branch.
Prefer they/them for anyone whose pronouns have not been stated.
