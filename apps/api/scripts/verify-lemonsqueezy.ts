/**
 * Checks a real Lemon Squeezy webhook against this adapter, without deploying anything.
 *
 * Everything about the adapter is tested against payloads I wrote, which proves it is
 * self-consistent and nothing about whether it matches what Lemon Squeezy actually sends. This
 * closes that gap with one real delivery:
 *
 *   1. Make a sandbox purchase.
 *   2. In the Lemon Squeezy dashboard open Settings → Webhooks → your endpoint, find the delivery,
 *      and copy the request body to a file and the X-Signature header value.
 *   3. pnpm tsx scripts/verify-lemonsqueezy.ts ./body.json <signature> <signing-secret>
 *
 * It prints what the adapter made of it. A parse of `null` means the shape differs from what we
 * expect — which fails closed in production, granting nothing, but silently.
 */
import { readFileSync } from 'node:fs';
import { LemonSqueezyAdapter } from '../src/billing/lemon-squeezy.adapter';

const [bodyPath, signature, secret] = process.argv.slice(2);
if (!bodyPath || !signature || !secret) {
  console.error('Usage: tsx scripts/verify-lemonsqueezy.ts <body.json> <signature> <secret>');
  process.exit(2);
}

// Read as bytes, never as a parsed object then re-serialised: the signature covers the exact
// bytes that arrived, and re-serialising is how a verification that proves nothing looks correct.
const rawBody = readFileSync(bodyPath);
const adapter = new LemonSqueezyAdapter({ get: () => undefined } as never);

const verified = adapter.verify(rawBody, signature, secret);
console.log(`signature: ${verified ? 'VALID' : 'INVALID'}`);
if (!verified) {
  console.error('\nThe signature did not match. Either the secret is wrong, or the body was');
  console.error('altered in transit — a copy-paste that reformats the JSON will do it.');
  process.exit(1);
}

const parsed = adapter.parse(JSON.parse(rawBody.toString('utf8')));
if (!parsed) {
  console.error('\nparse: NULL — the adapter does not recognise this payload.');
  console.error('In production this grants nothing, which is safe, but it does so silently.');
  console.error('Compare the payload against lemon-squeezy.adapter.ts and fix the mismatch.');
  process.exit(1);
}

console.log('parse: OK');
console.log(JSON.stringify(parsed, null, 2));
console.log(`\nidempotency key: ${adapter.idempotencyKey(rawBody).slice(0, 16)}…`);
