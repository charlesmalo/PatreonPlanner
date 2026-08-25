# 06. Security Standards

Security is judged even when the requirement never mentions it.

## 1. Secrets Never In Source

- No credentials, API keys, tokens, or connection strings in tracked files —
  including tests, fixtures, comments, and configuration.
- Configuration comes from the environment. Committed config carries
  **placeholders only**.
- If a secret is ever committed, **stop and tell the engineer immediately**.
  Rotation is their decision, not something to quietly paper over.

## 2. PII, Identity, and Path Sanitization

- Never commit personal data, real customer records, or third-party
  proprietary material.
- **Never write machine-specific absolute paths** into committed files, docs, or
  audit logs. Always repository-relative. A path containing a user account name
  is both a portability bug and a privacy leak.
- Test fixtures use obviously synthetic data.
- Store the minimum identity data the requirement actually needs.

## 3. Input Validation At The Boundary

- Validate everything crossing a trust boundary: request payloads, parameters,
  file contents, external responses.
- **Fail closed.** Reject unknown or malformed input rather than coercing it.
- Validate at the boundary, then trust the validated type inside.

## 4. Authorization Rules Specific To This Project

| Rule                                                                        | Why                                                                                                                     |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Every creator-scoped query filters on `creatorId`                           | An id alone says nothing about which board owns it; this is the defect class review has caught most often here          |
| A narrowing filter goes **inside** the same `AND` as the visibility rule    | A filter that replaces visibility returns the column rather than nothing                                                |
| Hidden content answers **404, not 403**                                     | Telling a reader an id exists but is not theirs confirms what sits on a board they cannot see                           |
| Client-side capability narrowing may **only remove**                        | If it could grant, a toggle in the browser would be an authorization decision                                           |
| New permissions **fail closed**                                             | A permission invented later is denied to everyone until granted                                                         |
| A URL from a non-staff submitter is a **candidate**, never a published link | Otherwise submitting a duplicate is link injection on someone else's board, carrying the creator's implicit endorsement |

## 5. Common Pitfalls

| Risk                   | Rule                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| Injection              | Parameterized queries only. Never concatenate untrusted input into a query, command, or template    |
| Sensitive data in logs | Log identifiers, never payloads, credentials, or personal data                                      |
| Error leakage          | Never return internal messages or stack traces to a caller                                          |
| Mass assignment        | Bind to explicit DTOs, never directly to internal models                                            |
| Path traversal         | Normalize and constrain any caller-influenced path before use                                       |
| Dependency risk        | New dependencies require approval                                                                   |
| Outbound data          | Sending data to an external service publishes it. Confirm before doing so                           |
| Stored user text       | Consider whether it needs storing at all — a blocked slur kept forever is a liability, not a record |

## 6. Errors Are Explicit

An error response tells the caller what it needs and nothing more. Internally,
errors carry enough context to diagnose. Externally, a stable code and a safe
message. **Never swallow an error silently.**

## 7. Worth Saying Out Loud

When a design touches authentication, money, or personal data, state the threat
model briefly even if nobody asked: what is trusted, what is not, and where the
boundary sits.
