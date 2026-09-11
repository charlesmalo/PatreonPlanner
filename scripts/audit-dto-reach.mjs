#!/usr/bin/env node
/**
 * Whether every field the API accepts can be sent by the client.
 *
 * The bug this exists for: `DecideLinkDto.isPreferred`. The API had a field for it, a
 * single-preferred invariant kept inside a transaction, a rule that preferring a candidate
 * publishes it, a read path that orders by it, and five integration assertions covering all of
 * that. No client ever sent it, so it was `false` on every row in every running system and the
 * ordering it drives never differed from insertion order.
 *
 * That is the same shape `audit-reachability.mjs` hunts one level down. A route can be reachable
 * while a capability *inside* it is not: `PATCH /creators/:slug/links/:id` was called all along,
 * by a component that only ever sent `{ status: 'PUBLISHED' }`.
 *
 * ## Why api/types.ts is excluded from the client side
 *
 * Naming a field in a response type is not sending it, and `isPreferred` was named there. Counting
 * that as a use is exactly what kept this invisible: the field looked wired up from both ends and
 * was connected at neither.
 *
 * ## What it cannot see
 *
 * A field whose name appears in the client for an unrelated reason. `status` and `reason` are
 * everywhere, so a DTO gaining one of those gets no scrutiny here. Silence is weak evidence; a
 * name that is missing is strong evidence. That is the same bargain the other route audit makes,
 * and it is why this reports how many fields it checked rather than only what it disliked.
 *
 * Run: `node scripts/audit-dto-reach.mjs`
 * Verified by mutation: removing the client that sends `isPreferred` makes it report exactly that
 * field, and no others.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Fields the client is not expected to send, with the reason. */
const EXPECTED = new Map([
  // None yet. An inbound payload the browser never posts — a webhook body, say — belongs here
  // with its reason rather than being quietly dropped from the scan.
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

// Naming a field in a response type is not sending it: see the note above.
const client = walk('apps/web/src')
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f) && !f.endsWith('api/types.ts'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

const dtoFiles = walk('apps/api/src').filter((f) => /\/dto\/.*\.ts$/.test(f));
const unsent = [];
let checked = 0;

for (const file of dtoFiles) {
  const source = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  // Per class, not per file: one file routinely holds a DTO and its nested item type.
  for (const part of source.split(/(?=export class )/)) {
    const found = /export class (\w+)/.exec(part);
    if (!found) continue;
    for (const match of part.matchAll(/^ {2}(\w+)[?!]?:/gm)) {
      const field = match[1];
      const key = `${found[1]}.${field}`;
      if (EXPECTED.has(key)) continue;
      checked += 1;
      if (!new RegExp(`\\b${field}\\b`).test(client)) unsent.push(key);
    }
  }
}

const stale = [...EXPECTED.keys()].filter((key) => !unsent.includes(key));

if (unsent.length === 0 && stale.length === 0) {
  console.log(`${dtoFiles.length} DTO files: ${checked} fields checked, every one reachable.`);
  process.exit(0);
}

if (unsent.length) {
  console.log('Fields the API accepts and no client sends:\n');
  for (const key of unsent) console.log(`  ${key}`);
  console.log(
    '\nThe route may well be called; the capability inside it is not. Wire it up, or add it' +
      '\nto EXPECTED with the reason nothing in a browser would ever send it.',
  );
}
if (stale.length) {
  console.log('\nEXPECTED names fields that are sent after all:\n');
  for (const key of stale) console.log(`  ${key}`);
}
process.exit(1);
