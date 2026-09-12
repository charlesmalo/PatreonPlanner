#!/usr/bin/env node
/**
 * Is any single file abandoned?
 *
 * The bug this exists for: `routes/Tickets.tsx` (157 statements), `routes/LandingPage.tsx` and
 * `App.tsx` all sat at **0% coverage, with no test file at all**, inside a web suite that passed
 * its 90% gate at 91.09%. A fourth, `components/safe-url.ts`, is the client half of an XSS
 * boundary and had its `catch` measured at zero executions across 458 tests.
 *
 * Nothing was wrong with any of them. The gate simply could not see them: **an aggregate cannot
 * tell "every file is decently covered" from "most files are excellent and three are zero."**
 * Both read 91%.
 *
 * ## Why this is a second gate rather than a bigger number
 *
 * The aggregate answers "is this codebase tested well". This answers "is any file abandoned".
 * One number cannot answer both, which is the whole finding — so the two are kept separate and
 * given different values on purpose. Raising the aggregate would not have caught a single one of
 * the four; lowering it to 75 would have weakened the thing that works.
 *
 * ## Why a script rather than config
 *
 * Neither runner can express it. Vitest's glob thresholds are aggregate over the matching set —
 * measured, not assumed: `'src/**' + '/*.{ts,tsx}': { lines: 99.99 }` reports 95.21%, the global
 * number, and a `perFile` key inside a glob group is ignored. Jest subtracts glob-matched paths
 * from the global bucket, so a catch-all glob would empty the 90% gate it sits beside.
 *
 * ## Lines and statements only
 *
 * Measured before choosing. At 75%, lines and statements bind 0 web files and (after the Patreon
 * client was covered) 0 API files above the size floor. Branches would fail 8 web and 12 API
 * files, functions 4 and 9 — because on a small file those percentages are dominated by how many
 * branches and functions the file happens to have, not by neglect: a two-function file with one
 * covered is 50%. Branches and functions stay governed by the aggregate gates, where they mean
 * something. A floor that fires on ordinary variation is one people learn to bypass.
 *
 * ## The size floor, and why it is reported rather than silent
 *
 * A percentage over three statements is an artifact of arithmetic: `availability.provider.ts` is
 * an abstract class whose two covered statements out of three read as 66.66%. Files below
 * MIN_STATEMENTS are exempt — and **counted out loud**, because a check that cannot tell a clean
 * tree from an empty one is the exact defect this family of audits keeps rediscovering in itself.
 *
 * **Except at zero.** A small file with no coverage at all is abandoned no matter how small it
 * is, and exempting it would reopen the hole this script exists to close — `safe-url.ts` is 8
 * statements and was one of the four finds. Size excuses a low percentage; it never excuses
 * nothing.
 *
 * Run: `node scripts/audit-coverage-floor.mjs <package-dir>`
 * Wired into each package's `coverage` script, so it cannot be run without fresh numbers and
 * cannot be skipped by running coverage on its own.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * Resolved from this file rather than from `process.cwd()`: each package's `coverage` script runs
 * with its own directory as the cwd, so a path relative to the cwd would resolve twice.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The floor. Deliberately below the worst real file, so it fires on neglect, not on variation. */
const FLOOR = 75;

/** Below this a percentage says more about the file's size than about its testing. */
const MIN_STATEMENTS = 10;

const METRICS = ['lines', 'statements'];

/**
 * Files allowed under the floor, with the reason. Empty on purpose: an allow-list carrying an
 * entry from birth is a gate negotiated against an existing violation, which is how gates die
 * (`coding_agent/07_TESTING_STANDARDS.md` §3). The Patreon HTTP client was the one candidate and
 * it was covered instead.
 */
const EXPECTED = new Map();

const pkg = process.argv[2];
if (!pkg) {
  console.error('Usage: node scripts/audit-coverage-floor.mjs <package-dir>');
  process.exit(2);
}

const summaryPath = join(REPO_ROOT, pkg, 'coverage', 'coverage-summary.json');
if (!existsSync(summaryPath)) {
  console.error(`No coverage summary at ${join(pkg, 'coverage', 'coverage-summary.json')}.`);
  console.error('Run the package’s `coverage` script; this check reads what it writes.');
  process.exit(2);
}

const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
const files = Object.entries(summary).filter(([key]) => key !== 'total');

// An empty report passes every threshold ever written. Refuse it rather than print a clean line.
if (files.length === 0) {
  console.error(`${pkg} coverage summary lists no files. Nothing was measured, so nothing is proven.`);
  process.exit(2);
}

const below = [];
const stale = [];
let checked = 0;
let tooSmall = 0;

for (const [absolute, entry] of files) {
  const name = absolute.startsWith(REPO_ROOT) ? absolute.slice(REPO_ROOT.length + 1) : absolute;
  // Nothing at all is never excused by size; see the header. A file with no statements to cover
  // is a type-only module and has nothing to say either way.
  const untouched = entry.statements.total > 0 && entry.statements.covered === 0;
  if (entry.statements.total < MIN_STATEMENTS && !untouched) {
    tooSmall += 1;
    continue;
  }
  checked += 1;
  const failed = METRICS.filter((metric) => entry[metric].pct < FLOOR);
  // Tested either way: an allowed file that has since risen above the floor should say so,
  // rather than keep an exemption nobody has rechecked.
  if (EXPECTED.has(name)) {
    if (failed.length === 0) stale.push(name);
    continue;
  }
  if (failed.length) {
    below.push(`${name} — ${failed.map((m) => `${m} ${entry[m].pct}%`).join(', ')}`);
  }
}

if (below.length === 0 && stale.length === 0) {
  console.log(
    `${pkg}: ${checked} files checked against a ${FLOOR}% floor (${METRICS.join(' and ')}), ` +
      `${tooSmall} under ${MIN_STATEMENTS} statements and exempt. None abandoned.`,
  );
  process.exit(0);
}

if (below.length) {
  console.log(`Files below the ${FLOOR}% floor:\n`);
  for (const line of below) console.log(`  ${line}`);
  console.log(
    '\nThe aggregate gate cannot see these: it is the average that passes, not the file.' +
      '\nAdd the tests, or add the file to EXPECTED with the reason it can never have them.',
  );
}
if (stale.length) {
  console.log(`\nEXPECTED names files that now clear the floor, so the entry is stale:\n`);
  for (const name of stale) console.log(`  ${name}`);
}
process.exit(1);
