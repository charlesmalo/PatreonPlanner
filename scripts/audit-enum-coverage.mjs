#!/usr/bin/env node
/**
 * Whether the client's response types list every value the API can send.
 *
 * The bug this exists for: `Notification.type` in `api/types.ts` named three of the five values
 * of the `NotificationType` enum. Leaving two out did not stop them arriving — it only meant
 * nothing was written for them, so `TICKET_RAISED` and `TICKET_RESOLVED` fell through to the
 * status branch and rendered "your message was updated on Ada Writes", pointing at the board.
 * The typechecker was happy, every test passed, and the union was simply a lie about the wire.
 *
 * ## Why it looks only at api/types.ts
 *
 * The obvious version checks every union of SCREAMING_CASE literals in the client. That was tried
 * and discarded: on a clean tree it reported four findings and all four were noise —
 *
 *   - `submit-payload.ts` narrows `RecommendationType` to the three kinds the submit form
 *     creates. Correct: it is describing what is *sent*, not what may be received.
 *   - `WatchOrderEditor.tsx` narrows it further, for the same reason.
 *   - `FlagActions.tsx` omits `OPEN` from `FlagStatus`, because `OPEN` is the state a flag starts
 *     in, not an action a moderator can take.
 *   - `Tickets.tsx` was matched against `FlagStatus` at all only because `TicketStatus` shares
 *     `OPEN` and `RESOLVED` with it.
 *
 * The distinguishing question is **direction** — a union of things we send may narrow freely, a
 * union of things we receive may not — and direction is not visible in the syntax. It *is* visible
 * in the file: `api/types.ts` holds the response shapes and nothing else. So the check is scoped
 * there rather than made cleverer.
 *
 * A broader sweep of enum values against the whole client was also tried and thrown away. It
 * reported `StaffRole` (rendered as `{member.role}`, so no value ever appears in source),
 * `ModerationActionType` and `ModerationSubjectType` (write-only audit tables the API never sends)
 * and `LinkStatus`. Four findings, four false positives. A tool that cries wolf on a clean tree
 * gets ignored, or worse, believed.
 *
 * Run: `node scripts/audit-enum-coverage.mjs`
 * Verified by putting the original three-value `NotificationType` union back and watching it fail.
 */
import { readFileSync } from 'node:fs';

const SCHEMA = 'apps/api/prisma/schema.prisma';
const TYPES = 'apps/web/src/api/types.ts';

/** Unions the client narrows on purpose, with the reason. */
const EXPECTED = new Map([
  // None yet. A response type that legitimately carries a subset belongs here with its reason,
  // not silently.
]);

const schema = readFileSync(SCHEMA, 'utf8');
const enums = new Map();
for (const m of schema.matchAll(/enum (\w+) \{([^}]*)\}/g)) {
  const values = m[2]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'));
  enums.set(m[1], new Set(values));
}

const source = readFileSync(TYPES, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const problems = [];
for (const m of source.matchAll(/((?:'[A-Z][A-Z0-9_]*'\s*\|\s*)+'[A-Z][A-Z0-9_]*')/g)) {
  const used = new Set([...m[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((x) => x[1]));
  // The enum this union mirrors: every member must belong to it, and of those, the one it covers
  // most completely. A union covering 5 of 5 is a better match than one covering 2 of 6.
  let best = null;
  for (const [name, values] of enums) {
    if ([...used].every((v) => values.has(v))) {
      const score = used.size / values.size;
      if (!best || score > best.score) best = { name, values, score };
    }
  }
  if (!best) continue;
  const missing = [...best.values].filter((v) => !used.has(v));
  if (missing.length && !EXPECTED.has(best.name)) {
    problems.push({ name: best.name, missing, covered: used.size, total: best.values.size });
  }
}

if (problems.length === 0) {
  console.log(`${TYPES}: every union covers the enum it mirrors.`);
  process.exit(0);
}
console.log(`${TYPES} omits values the API can send:\n`);
for (const p of problems) {
  console.log(`  ${p.name}  ${p.covered}/${p.total}  missing: ${p.missing.join(' ')}`);
}
console.log('\nA value left out still arrives; it just has nothing written for it.');
process.exit(1);
