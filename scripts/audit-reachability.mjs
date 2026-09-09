#!/usr/bin/env node
/**
 * Which API routes nothing in the client can reach.
 *
 * This exists because the same defect has now shipped three times — the tier gates, the
 * blocklist, the ticket notifications — and it is invisible to the test suite by construction.
 * Every one of them was complete server-side and covered by tests, because the tests were written
 * from the same understanding that produced the gap. Nothing failed. There was simply no way in.
 *
 * ## Why it compares segments rather than call sites
 *
 * The obvious version greps for `api.get('/some/path')` and matches those against the routes.
 * It is wrong here, and quietly: this codebase routinely builds a path into a variable first —
 *
 *     const path = `/creators/${slug}/recommendations/${id}/follow`;
 *     await api.post(path);
 *
 * — so a literal-argument regex sees no call and reports a live, working feature as unreachable.
 * Written that way this audit claimed 14 misses, then 47, then 20, none of which were true. It
 * also splits on `@Controller` per class rather than per file, because `staff.controller.ts`
 * declares two and attributing the second one's routes to the first one's prefix invents routes
 * that do not exist.
 *
 * What holds regardless of how the call is spelled is the path segment itself: `follow` appears
 * in the source whether the URL is a literal, a template, or built up in three steps. So the test
 * is presence, not shape. It cannot prove a route *is* reached — only that one whose deepest
 * segment appears nowhere in the client cannot possibly be. That is the direction that matters,
 * and it does not produce false alarms.
 *
 * ## What it cannot see
 *
 * A route whose deepest segment is a common word is invisible to this. `/auth/patreon/login` and
 * `/webhooks/patreon/:creatorId` never appear below, because `login` and `patreon` occur all over
 * the client for unrelated reasons — both happen to be fine, but a route named `/creators/:slug/list`
 * would be missed the same way and would not be. The check is one-sided on purpose: silence here
 * is weak evidence, while a name that appears is strong evidence.
 *
 * Run: `node scripts/audit-reachability.mjs`
 * Exits non-zero if anything is unreachable that is not on the allow list below.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Reached by the browser or another server, never by client code. Each needs a reason. */
const EXPECTED = new Map([
  ['GET /auth/patreon/callback', 'OAuth redirect target; the browser arrives here, not a fetch'],
  ['GET /billing/fake-checkout', 'The stand-in checkout page, navigated to'],
  ['POST /billing/fake-checkout', 'Submitted by that page as a form'],
  ['GET /email/unsubscribe', 'A link in an email, opened outside the app'],
  ['GET /healthz', 'Infrastructure'],
  ['GET /readyz', 'Infrastructure'],
  ['POST /webhooks/resend', 'Inbound from Resend'],
  ['POST /billing/webhook', 'Inbound from the payment provider'],
  [
    'POST /creators/claim',
    'KNOWN GAP, and the largest one this audit has found: nothing in the client claims a board, ' +
      'so a creator cannot create one. Every board that exists was seeded by SQL or by a test. ' +
      'A UI also needs an endpoint listing the caller’s owned campaigns — `claim` takes a ' +
      'patreonCampaignId the client has no way to learn. See PROGRESS_TRACKER.md.',
  ],
  [
    'PUT /creators/:creatorId/webhook-secret',
    'KNOWN GAP: no UI exists, and without a secret the signature guard rejects every delivery. ' +
      'Deliberately deferred — it is a credential from Patreon’s developer portal and needs a ' +
      '`webhookConfigured` flag to be useful. See PROGRESS_TRACKER.md.',
  ],
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const apiFiles = walk('apps/api/src').filter((f) => f.endsWith('.ts'));
const routes = new Set();
for (const file of apiFiles) {
  const source = readFileSync(file, 'utf8');
  // Per class, not per file: two @Controller declarations in one file have different prefixes.
  for (const part of source.split(/(?=@Controller\()/)) {
    const controller = /^@Controller\((?:'([^']*)')?\)/.exec(part);
    if (!controller) continue;
    const prefix = controller[1] ?? '';
    for (const m of part.matchAll(/@(Get|Post|Patch|Put|Delete)\((?:'([^']*)')?\)/g)) {
      const path = [prefix, m[2] ?? ''].filter(Boolean).join('/');
      routes.add(`${m[1].toUpperCase()} /${path}`);
    }
  }
}

/**
 * Comments are stripped first, and that is not a detail.
 *
 * A component's own doc comment routinely names the thing it talks to — `Blocklist.tsx` explains
 * why the blocklist sits under ADMINISTER — so the word survives even after every call to the
 * route is deleted. Checked by removing all four uses of `/blocklist` from that file: with prose
 * included the audit still passed, on a client that could no longer reach the route at all.
 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const client = walk('apps/web/src')
  .filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'))
  .map((f) => stripComments(readFileSync(f, 'utf8')))
  .join('\n');

const unreachable = [];
for (const route of [...routes].sort()) {
  const [, path] = route.split(' ');
  const segments = path.split('/').filter((s) => s && !s.startsWith(':'));
  const deepest = segments.at(-1);
  if (deepest && !client.includes(deepest)) unreachable.push(route);
}

const unexpected = unreachable.filter((r) => !EXPECTED.has(r));
const stale = [...EXPECTED.keys()].filter((r) => !unreachable.includes(r));

console.log(`${routes.size} routes; ${unreachable.length} unreachable from the client.\n`);
for (const route of unreachable) {
  const why = EXPECTED.get(route);
  console.log(why ? `  ok        ${route}\n              ${why}` : `  UNREACHED  ${route}`);
}
if (stale.length) {
  // An entry that no longer matches anything is a note about a route that moved or was deleted,
  // and it would otherwise sit here excusing something that no longer exists.
  console.log(`\nAllow-list entries matching no route (remove them):`);
  for (const route of stale) console.log(`  ${route}`);
}
if (unexpected.length) {
  console.log(`\n${unexpected.length} route(s) nothing in the client can reach.`);
  console.log('Either wire it up, or add it to EXPECTED with the reason it is fine.');
}
process.exit(unexpected.length || stale.length ? 1 : 0);
