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
  // None yet. A field a browser genuinely never sends belongs here with its reason — but note
  // that an entry is only verifiable when the field's name is distinctive, because "not sent"
  // is inferred from the name being absent. A whole category of never-sent payloads is excluded
  // by path instead; see INBOUND below.
]);

/**
 * Payload shapes posted *to* us, which no browser is supposed to send.
 *
 * Excluded as a category rather than field by field. `PatreonEventDto.data` passes the scan
 * today only because the word "data" occurs in the client for unrelated reasons — an accident
 * that would turn into a false alarm the day someone renames it to `resource`. A per-field
 * allow-list cannot express this honestly either: the check infers "not sent" from the name
 * being absent, so it would report a coincidentally-present name as proof the entry was stale.
 */
const INBOUND = /\/(webhooks)\/dto\//;

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

const dtoFiles = walk('apps/api/src').filter((f) => /\/dto\/.*\.ts$/.test(f) && !INBOUND.test(f));
const unsent = [];
const stale = [];
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
      checked += 1;
      const missing = !new RegExp(`\\b${field}\\b`).test(client);
      // Tested either way. Skipping an allowed field before testing it would make every entry
      // here permanently unverifiable — and an entry that has quietly become wrong is the thing
      // an allow-list is most likely to be hiding.
      if (EXPECTED.has(key)) {
        if (!missing) stale.push(key);
        continue;
      }
      if (missing) unsent.push(key);
    }
  }
}

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
  console.log('\nEXPECTED names fields the client does send, so the entry is stale:\n');
  for (const key of stale) console.log(`  ${key}`);
}
process.exit(1);
