#!/usr/bin/env node
/**
 * Every path excluded from the API's global prefix is forwarded by both proxies — or listed here
 * as deliberately not forwarded.
 *
 * These are the same list seen from opposite ends. `app.setup.ts` excludes a path from `/api/v1`
 * because an outside party registered the URL — Patreon, Resend — and the proxies in front of the
 * one origin have to carry those paths through. They drifted once: `webhooks/*` was excluded and
 * never proxied, so every Patreon and Resend delivery for the life of the project was answered by
 * the SPA fallback.
 *
 * The failure has no symptom on this side. A path nginx does not forward is served `index.html`
 * with **200**, or 405 for a POST — the API is simply never asked. Memberships arrived at the next
 * sync instead of immediately, which looks like latency rather than a broken integration, and the
 * settings page displayed a delivery URL nothing was listening on.
 *
 * Run: `node scripts/audit-proxy-paths.mjs`
 */
import { readFileSync } from 'node:fs';

const SETUP = 'apps/api/src/app.setup.ts';
const NGINX = 'apps/web/nginx.conf';
const VITE = 'apps/web/vite.config.ts';

/** Excluded and deliberately not proxied. Each needs a reason, and the reason has to still hold. */
const NOT_PROXIED = new Map([
  [
    'healthz',
    'Reaching it through the web origin would answer 200 text/html from the SPA anyway. ' +
      'Proxying it would publish readiness — which names the dependencies that are down. ' +
      'Compose health checks hit the API container directly. See docs/decisions/2026-08-08.',
  ],
  ['readyz', 'Same as healthz.'],
]);

// Comments stripped first: the exclusion list is annotated, and an apostrophe in prose —
// "Resend's dashboard" — is otherwise read as the start of a quoted path. The first run of this
// script reported a route called "s dashboard, so it must not move when".
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const setup = stripComments(readFileSync(SETUP, 'utf8'));
const excludeBlock = /exclude:\s*\[([\s\S]*?)\]/.exec(setup);
if (!excludeBlock) {
  console.error(`Could not find the exclude list in ${SETUP}.`);
  process.exit(1);
}
// The first path segment is what a proxy location matches on; the rest is the route's own shape.
const excluded = [...excludeBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const prefixes = [...new Set(excluded.map((p) => p.split('/')[0]))];

const nginx = readFileSync(NGINX, 'utf8').replace(/^\s*#[^\n]*/gm, '');
const vite = stripComments(readFileSync(VITE, 'utf8'));
// `location /x/ { proxy_pass ... }` — a location that only serves files does not count.
const nginxProxied = new Set(
  [...nginx.matchAll(/location\s+\/([^/\s]+)\/\s*\{([^}]*)\}/g)]
    .filter((m) => m[2].includes('proxy_pass'))
    .map((m) => m[1]),
);
const viteProxied = new Set([...vite.matchAll(/'\/([^/'\s]+)'\s*:\s*'http/g)].map((m) => m[1]));

const problems = [];
for (const prefix of prefixes) {
  const reason = NOT_PROXIED.get(prefix);
  const inNginx = nginxProxied.has(prefix);
  const inVite = viteProxied.has(prefix);
  if (reason) {
    // A path excused here but proxied anyway means the excuse is stale and misleading.
    if (inNginx || inVite) {
      problems.push(`${prefix}: listed as deliberately not proxied, but it is proxied.`);
    }
    continue;
  }
  if (!inNginx) problems.push(`${prefix}: excluded from the API prefix, not forwarded by nginx.`);
  if (!inVite) problems.push(`${prefix}: excluded from the API prefix, not forwarded by Vite.`);
}
// An entry for a path that is no longer excluded is excusing something that does not exist.
for (const prefix of NOT_PROXIED.keys()) {
  if (!prefixes.includes(prefix)) {
    problems.push(`${prefix}: on the not-proxied list but no longer excluded from the prefix.`);
  }
}

console.log(`Prefix exclusions: ${prefixes.join(', ')}`);
console.log(`nginx forwards:    ${[...nginxProxied].join(', ')}`);
console.log(`vite forwards:     ${[...viteProxied].join(', ')}\n`);

if (problems.length === 0) {
  console.log('Every excluded path is forwarded, or listed with a reason.');
  process.exit(0);
}
for (const problem of problems) console.log(`  ${problem}`);
console.log('\nA path the proxy does not forward is answered by the SPA, not by an error.');
process.exit(1);
