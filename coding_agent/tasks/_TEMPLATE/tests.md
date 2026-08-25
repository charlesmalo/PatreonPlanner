# Test Plan — <task name>

> Written before implementation. Boundaries first, happy path last.

## Unit tests

| Behaviour | Boundary / edge                      | The production change that would fail it |
| --------- | ------------------------------------ | ---------------------------------------- |
|           | zero / empty / null / negative / max |                                          |

## Integration tests

| Slice | Asserts                                                 | The production change that would fail it |
| ----- | ------------------------------------------------------- | ---------------------------------------- |
|       | status, payload shape, validation failures, persistence |                                          |

## Composition guard

| Behaviour                                                 | Test name |
| --------------------------------------------------------- | --------- |
| The assembled system works end to end, not just its parts |           |

## Mutation checks

Anything with teeth — authorization, visibility, ordering, tenancy — is reverted
and confirmed to fail a test (`07_TESTING_STANDARDS.md` §7).

| Rule reverted | Test that must fail |
| ------------- | ------------------- |
|               |                     |
