# Coarse Request Limiter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a ceiling on how fast anyone can hit the API — design §6.2's Redis token bucket, keyed by IP *and* user, which has now been deferred three times while the surfaces it protects kept growing.

**Architecture:** One Lua script implements a token bucket atomically; a Nest guard applies it to every mutating route plus the one expensive read. Client IP resolution is explicit configuration rather than a default, because both wrong answers are bad in different ways: trust too much and anyone forges their identity, trust too little and every request behind a proxy shares one bucket.

**Tech Stack:** Redis (already present), NestJS 10. **No new dependency, no service, no cost.**

## Global Constraints

- **A limiter that can be evaded is theatre.** The IP must come from a source the client cannot forge, which means knowing exactly how many proxies sit in front.
- **A limiter that blocks real use is worse than none.** Limits are generous velocity caps, not quotas: design §6.2 is explicit that upvotes get "a generous velocity cap … without hindering normal use".
- **Both buckets must pass.** Per-user alone lets one person spread across a botnet; per-IP alone lets a NAT full of patrons throttle each other.
- **Redis being down must not take the API down.** A limiter that fails closed turns a cache outage into a total outage.
- **The 429 says when to come back** and nothing about the rule (design §9).

## Scope

**In scope:** the token bucket, client-IP resolution and its configuration, a guard applied to mutating routes and to board search, `Retry-After` on refusal, and the operational documentation that makes the proxy setting correct rather than guessed.

**Out of scope — deliberately deferred, with the reason:**

- **CDN/WAF, bot fingerprinting, CAPTCHA** (design §6.1) → these are edge concerns that belong in front of the app, and every option that is actually free at the volumes in question is a hosting decision rather than code. This plan is the application-level floor beneath them.
- **Per-route limits tuned individually** → one generous mutating-route bucket and one search bucket. Tuning each endpoint separately invents numbers nobody has data for; the shape lets it happen later.
- **Distributed coordination beyond Redis** → the bucket is already atomic in one round trip, and the app is stateless by design §2.
- **Limiting reads generally** → the board is cached-ish and cheap; search is the one read with a measured cost, so it is the one read that gets a bucket.

## Decisions this plan settles

**Token bucket, not the existing fixed window.** `RateLimitService` counts per fixed window, which lets someone spend a full allowance at the end of one window and another at the start of the next — a 2× burst at every boundary. A bucket refilling continuously has no boundary to exploit, and it is what design §6.2 names. The existing fixed-window service stays where it is: submission quotas *want* window semantics ("one an hour" means one an hour).

**Trusted proxy depth is required configuration with an unsafe-by-default refusal.** `TRUSTED_PROXY_HOPS` defaults to `0`, and at `0` behind a proxy every caller shares one bucket — the limiter still functions, it is just useless. The alternative default, trusting `X-Forwarded-For` blindly, lets any client claim any IP: they evade their own limit *and* can exhaust someone else's. Between "degraded and obvious" and "broken and silent", this takes the first, and logs a warning at boot so it does not stay unnoticed.

**Both buckets are checked, and the tighter refusal wins.** A request presents an IP always and a user sometimes. Anonymous traffic is limited by IP alone; authenticated traffic must satisfy both, so a compromised account cannot spread across hosts and a shared NAT cannot be used to starve everyone behind it.

**Redis failure fails open.** If the script errors or Redis is unreachable, the request proceeds and the failure is logged. A limiter is a safety margin; making it a hard dependency converts a degraded cache into a dead API, which is a strictly worse outcome than a few minutes without rate limiting.

**Search gets its own, tighter bucket.** It is a read, so it is not covered by "mutating endpoints", but it is the one endpoint with a measured per-request cost and it is reachable anonymously. Its bucket is separate so tightening it later does not affect anything else.

---

## Task 1: The token bucket

**Files:**

- Create: `apps/api/src/limits/token-bucket.service.ts`
- Test: `apps/api/test/token-bucket.int-spec.ts`

**Interfaces:**

- `TokenBucketService.take(key, capacity, refillPerSecond): Promise<{ allowed: boolean; retryAfterSeconds: number }>`

- [ ] **Step 1: Write the failing test**

```ts
it('allows a burst up to the capacity', async () => {
  for (let i = 0; i < 5; i += 1) expect((await bucket.take('k', 5, 1)).allowed).toBe(true);
});

it('refuses once the burst is spent', async () => {
  for (let i = 0; i < 5; i += 1) await bucket.take('k', 5, 1);
  expect((await bucket.take('k', 5, 1)).allowed).toBe(false);
});

it('says when to come back', async () => {
  for (let i = 0; i < 5; i += 1) await bucket.take('k', 5, 1);
  const refused = await bucket.take('k', 5, 1);
  expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  expect(refused.retryAfterSeconds).toBeLessThanOrEqual(1);
});

it('refills over time', async () => {
  for (let i = 0; i < 2; i += 1) await bucket.take('k', 2, 10);
  expect((await bucket.take('k', 2, 10)).allowed).toBe(false);
  await sleep(250);
  expect((await bucket.take('k', 2, 10)).allowed).toBe(true);
});

it('never refills past the capacity', async () => {
  await bucket.take('k', 3, 1000);
  await sleep(100);
  // A long idle period must not bank an unbounded burst.
  let allowed = 0;
  for (let i = 0; i < 10; i += 1) if ((await bucket.take('k', 3, 1000)).allowed) allowed += 1;
  expect(allowed).toBeLessThanOrEqual(10);
});

it('keeps keys apart', async () => { ... });

it('is atomic under concurrency', async () => {
  // Read-then-write would let ten simultaneous requests all see a full bucket.
  const results = await Promise.all(Array.from({ length: 10 }, () => bucket.take('k', 3, 0.001)));
  expect(results.filter((r) => r.allowed)).toHaveLength(3);
});

it('expires an idle bucket rather than keeping it forever', async () => { ... });

it('allows the request when Redis fails, rather than failing closed', async () => {
  // A limiter is a safety margin; a hard dependency turns a cache outage into an API outage.
  expect((await brokenBucket.take('k', 1, 1)).allowed).toBe(true);
});
```

- [ ] **Step 2: Run, watch fail, implement**

```lua
local now, capacity, refill = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(state[1]) or capacity
local at = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + (now - at) * refill)
local allowed = tokens >= 1
if allowed then tokens = tokens - 1 end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'at', now)
redis.call('EXPIRE', KEYS[1], ARGV[4])
return { allowed and 1 or 0, tostring((1 - tokens) / refill) }
```

The clock comes from the caller, not `redis.call('TIME')`, so the script stays deterministic and
testable — and Redis replicas do not disagree about now.

- [ ] **Step 3: Run and commit**

---

## Task 2: Client IP resolution

**Files:**

- Modify: `apps/api/src/app.setup.ts`, `apps/api/src/config/config.schema.ts`
- Create: `apps/api/src/limits/client-ip.ts`
- Test: `apps/api/test/client-ip.e2e-spec.ts`

**Interfaces:**

- `clientIp(request, trustedHops): string`
- `TRUSTED_PROXY_HOPS` config, default `0`.

- [ ] **Step 1: Write the failing test**

```ts
it('uses the socket address when nothing is trusted', () => {
  // The one answer a client cannot forge.
  expect(clientIp(req({ socket: '203.0.113.9', xff: '1.2.3.4' }), 0)).toBe('203.0.113.9');
});

it('ignores a forged X-Forwarded-For when nothing is trusted', () => {
  expect(clientIp(req({ socket: '203.0.113.9', xff: 'evil, 1.2.3.4' }), 0)).toBe('203.0.113.9');
});

it('takes the hop before the trusted proxy', () => {
  // One proxy in front: the last XFF entry is the one that proxy wrote, which the client
  // cannot control.
  expect(clientIp(req({ socket: '10.0.0.1', xff: 'client, 198.51.100.7' }), 1)).toBe('198.51.100.7');
});

it('counts hops from the right, not the left', () => {
  expect(clientIp(req({ socket: '10.0.0.1', xff: 'a, b, real, p1, p2' }), 2)).toBe('real');
});

it('falls back to the socket when the header is too short to trust', () => {
  // Fewer entries than configured hops means the header was not written by the proxies we
  // expect; believing it would be believing the client.
  expect(clientIp(req({ socket: '10.0.0.1', xff: 'client' }), 2)).toBe('10.0.0.1');
});

it('never returns an empty string', () => { ... });
```

- [ ] **Step 2: Implement, and warn at boot**

When `TRUSTED_PROXY_HOPS` is `0`, log once at startup that per-IP limiting will treat all proxied
traffic as a single client. Silence here is how a deployment ships with a limiter that does
nothing.

- [ ] **Step 3: Run and commit**

---

## Task 3: The guard

**Files:**

- Create: `apps/api/src/limits/rate-limit.guard.ts`
- Modify: `apps/api/src/app.setup.ts` or `app.module.ts` (register globally), `apps/api/src/config/config.schema.ts`
- Test: `apps/api/test/coarse-limit.int-spec.ts`

**Interfaces:**

- Applied globally; skips safe methods except the routes that opt in with `@RateLimited('search')`.
- Config: `COARSE_LIMIT_BURST`, `COARSE_LIMIT_PER_MINUTE`, `SEARCH_LIMIT_BURST`, `SEARCH_LIMIT_PER_MINUTE`.

- [ ] **Step 1: Write the failing test**

```ts
it('lets ordinary use through', async () => {
  // The limit must not be reachable by a person using the product normally.
  for (let i = 0; i < 20; i += 1) await upvote(patron, id).expect(201);
});

it('refuses once the burst is spent, with a Retry-After', async () => {
  const res = await exhaustMutations(patron);
  expect(res.status).toBe(429);
  expect(res.headers['retry-after']).toBeDefined();
});

it('says nothing about the rule', async () => {
  const res = await exhaustMutations(patron);
  expect(JSON.stringify(res.body)).not.toMatch(/bucket|token|ip|limit of/i);
});

it('does not limit reads', async () => {
  for (let i = 0; i < 50; i += 1) await board(patron).expect(200);
});

it('limits search, which is the one read with a cost', async () => {
  const statuses = [];
  for (let i = 0; i < 40; i += 1) statuses.push((await search(patron, 'totoro')).status);
  expect(statuses).toContain(429);
});

it('limits two users from one address', async () => {
  // Per-user alone lets a botnet through; the IP bucket is what catches it.
  await exhaustMutations(patron);
  expect((await upvote(otherPatron, id)).status).toBe(429);
});

it('limits one user across addresses', async () => {
  // And per-IP alone lets one account spread; both buckets must pass.
  ...
});

it('lets an anonymous caller through until its address is spent', async () => { ... });

it('proceeds when Redis is unreachable', async () => { ... });
```

- [ ] **Step 2: Run, watch fail, implement, commit**

---

## Task 4: End-to-end and verification

**Files:**

- Modify: `e2e/tests/support.ts` (the existing limiter reset must clear buckets too), `README.md`

- [ ] **Step 1: Make the suites survive it**

Every E2E request comes from one address, so the per-IP bucket must be cleared between tests by
the reset helper that already exists — and the limits must be generous enough that a single
journey never trips one.

- [ ] **Step 2: Full verification**

```bash
pnpm -r typecheck && pnpm -r test && pnpm format:check
docker-compose -f docker-compose.e2e.yml up -d --build && pnpm --filter e2e e2e
```

- [ ] **Step 3: Document the proxy setting in the README — including that getting it wrong is silent — and commit**

---

## Self-Review

**Spec coverage (design §6.2):**

- "Redis token-bucket on all mutating endpoints" → Tasks 1, 3. ✅
- "keyed by IP *and* user" → Task 3, both buckets, both must pass. ✅
- "generous velocity cap … without hindering normal use" → Task 3's first test asserts exactly this. ✅
- "Applies to upvotes" → upvotes are a mutating route and are covered by the same bucket. ✅
- Edge/DDoS, fingerprinting, CAPTCHA (§6.1) → **deferred**, with the reason in Scope.

## Found in review (fixed)

1. **Critical — clock skew drove buckets negative and locked callers out indefinitely.** The
   script had a ceiling but no floor, and took the clock from the *caller*. With two instances
   30s apart, one request from the instance ahead emptied the shared bucket and the one behind
   was refused **every** request until real time caught up. My own comment asserted that taking
   the clock from the caller was what stopped replicas disagreeing — the reasoning was exactly
   backwards: `redis.call('TIME')` is the single clock that makes them agree. Now Redis's clock,
   with a floor as well as a cap.
2. **Critical — `TRUSTED_PROXY_HOPS=0` behind a proxy was a whole-site denial-of-service lever,
   and it is the shipped default.** This plan called it "degraded but obvious". It was not: every
   request presents the proxy's address, both buckets must pass, so one anonymous client at a few
   requests a second refuses **every** mutating request for everybody — including webhook
   deliveries — indefinitely. The limiter would have been the outage it exists to prevent. Per-IP
   limiting now switches itself off when the address is plainly a proxy we were told not to trust,
   and logs an error.
3. **Important — Patreon webhooks shared the human bucket.** Every delivery arrives from one
   egress range, so a campaign's charge-day traffic would 429 and membership state would go
   silently stale. Exempted: they carry an HMAC, a stronger gate than a velocity cap.
4. **Important — the per-user bucket, half of "keyed by IP *and* user", had no coverage at all.**
   Deleting it left all eight tests green, because every request in the suite came from one
   socket. Worse, my first attempt at a test for it *also* passed with the bucket deleted — it
   sent more than the burst from the second address, so the address bucket refused it anyway.
5. **Important — the two genuinely expensive routes were unmetered.** `GET /catalog/search`
   spends third-party quota per miss and `GET /auth/patreon/login` writes an unauthenticated
   Redis key on every hit; both were exempt because the verb is GET, while the bucket went to the
   local trigram query that already has a statement timeout.
6. **Important — a Redis outage produced one or two log lines per request.** Now logged on the
   transition into and out of degradation.
7. **Minor, also fixed:** `Retry-After` reported the *first* refusal rather than the longest, so a
   client retried into a refusal it could not pass, contradicting the class comment; `reset()` did
   a `KEYS` scan on an app-wide injected service, the exact griefing primitive the test harness
   exists to keep off one; and `.env.example` introduced the proxy setting under an unrelated
   comment.

**Known risks:**

0. **The ceiling only applies to well-formed requests.** CSRF middleware runs before guards, so a
   rejected request spends nothing, and Nest guards do not run for unmatched routes, so a 404 is
   free. Absorbing malformed floods is the edge layer's job (design §6.1) — but it means this is a
   ceiling on *use*, not on traffic, and the plan's goal line overstated it.

1. **`TRUSTED_PROXY_HOPS` is a footgun by construction.** Set it too high and a client can forge its address by stuffing `X-Forwarded-For`; too low and everyone behind the proxy shares a bucket. There is no safe default because the right answer is a property of the deployment, not the code. The boot warning covers the second case; nothing detects the first.
2. **IPv6 is limited per address, not per prefix.** A single /64 is routinely one household, but it is also trivially thousands of addresses to an attacker with a real allocation. Per-prefix bucketing is the right answer and needs a prefix-length decision nobody has made.
3. **Failing open means an attacker who can disrupt Redis disables the limiter.** That is the deliberate trade — a limiter that fails closed converts a cache blip into an outage — but it does mean the limiter is not a defence against someone who already has that reach.
4. **The buckets are global, not per creator.** Hitting one board hard spends the same allowance as spreading across many. Right for an abuse ceiling, but it means a genuinely busy patron of many creators reaches it sooner than one loyal to a single board.
