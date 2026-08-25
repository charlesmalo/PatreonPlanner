# 08. Token Efficiency & Context Logging

## Why This Exists

Context is the scarcest resource in any agent session. An agent that burns its
budget re-reading files it already processed, or re-deriving work it already
finished, stalls at the worst possible moment — and the next agent starts from
nothing.

## 1. Reuse Before Generating

- Before writing any utility, check `03_ARCHITECTURE_AND_DOCS.md`.
- Before writing any rule or document, search `coding_agent/` for one that
  already covers it. **Extend or correct it — never fork it.**
- Before re-analyzing anything, check the task audit log.

## 2. Read Narrowly

- **Never bulk-load a large file just to skim it.** Search for the section, then
  read only that range.
- Prefer targeted search over directory walks.
- Read a file in full only when targeted extraction genuinely fails.
- **Shed context.** Do not keep files in working context once their task is done.

## 3. Log Incrementally, Not At The End

For any multi-step task, maintain `tasks/<task>/logs/00_AUDIT_LOG.md`.

```
## YYYY-MM-DD — <short title>
- Completed: <what actually landed>
- Decision: <what was chosen> because <the property of the problem that drove it>
- Rejected: <the alternative> because <why it loses here>
- Verified: <command> → <observed output>
- Remaining: <what is still open>
```

Write entries **after each meaningful chunk of work**, not when the task
finishes. Use absolute dates. Never write "yesterday" or "last week".

For work of any size, this project's durable record is the **plan document** in
`docs/superpowers/plans/`, which carries a "Found in review (fixed)" section
after review. That is the audit log for a merged feature; the task folder is for
work in flight.

## 4. Resuming Interrupted Work

Before starting a task that already has a folder, read its `tracker.md` and the
most recent audit log entries first. Do not restart finished sub-steps.

## 5. Fan Out Efficiently

When a task decomposes into genuinely independent units, prefer one focused agent
per unit over one agent reading everything. Give each agent only the paths it
needs. Fan-out hides work from the engineer's view and adds latency — ask before
dispatching.

## 6. Output Discipline

Lead with the outcome, no preamble, no narration of the obvious, no restating the
request (`02_COLLABORATION_PROTOCOL.md` §3).
