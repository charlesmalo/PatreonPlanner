# Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make premium reachable — a reader can buy it, keep it, and lose it — without this application ever touching a card number or a billing address.

**Architecture:** A `Subscription` row is the truth; `User.premiumUntil` stays as a projection of it. That keeps all five existing premium gates untouched: they already read `premiumUntil` and will go on reading it. Entitlement changes only ever come from a **verified webhook** or from **polling the provider** — never from the browser coming back from checkout.

**Tech Stack:** NestJS 10, Prisma 5 + Postgres 16, BullMQ (already wired), Lemon Squeezy as merchant of record.

## Global Constraints

- **No fixed cost.** A merchant-of-record provider charges per transaction, not per month, so the free-tier-only constraint holds: nothing is owed until money arrives. This is the first dependency with any cost at all, and it is proportional to revenue by construction.
- **No card data and no billing PII, ever.** Checkout is a hosted page on the provider's domain. We store their subscription id, their customer id, and a status. Not a name, not an address, not a last-four.
- **Premium never enters `can(capability, viewer, policy)`.** Amendment A.1 holds unchanged; nothing in this plan touches `Viewer`.
- **The provider is behind one adapter.** Lemon Squeezy today, Paddle if that changes — the difference must be one file, not a search-and-replace.

---

## The rule everything here follows

**A browser redirect is not a payment.** The single most common way billing goes wrong is granting entitlement when the user returns to `/success`, because that URL is reachable by typing it. Entitlement is granted by a webhook we verified, or by asking the provider directly. The redirect gets the reader a friendly page and nothing else.

## Decisions this plan settles

- **`premiumUntil` stays, as a projection.** Five gates read it — notification preferences, carry-over, board settings, the reaction palette, the session guard. Making the subscription their source of truth directly would mean five call sites and five chances to differ. Instead the billing service writes the projection whenever the subscription changes.
- **Webhook events are de-duplicated by the provider's event id.** Providers retry on any non-2xx and on timeouts, so the same "subscription created" can arrive three times. Nothing in this codebase de-duplicates webhooks today; Patreon's handler is idempotent by accident of what it does, not by design.
- **A failed payment does not revoke immediately.** `past_due` keeps entitlement for a grace window, because a card that expired on Tuesday is not a reader who stopped paying — and taking the palette away mid-retry is a worse experience than the retry succeeding a day later.
- **Reconciliation runs on the existing tick.** Webhooks get lost: a deploy mid-delivery, a timeout, a bug in our own handler. A subscription whose period has ended without a renewal event is re-checked against the provider rather than assumed dead.
- **One active subscription per user**, enforced by a unique index. Two would make "are they premium" a question with two answers.

## Scope

**In:** the `Subscription` and `ProcessedWebhookEvent` models; the entitlement projection with its grace window; checkout link creation; webhook ingestion with signature verification and idempotency; the reconciliation job; a page to buy and to manage.

**Out, with reasons:**
- *Proration, plan changes, and multiple tiers.* One plan exists. Everything here is simpler with one, and none of it is hard to add when there are two.
- *Refunds initiated from this app.* The provider's dashboard does it, and a refund arrives here as a webhook like anything else.
- *Invoices and receipts.* The merchant of record issues them; that is most of what we are paying them for.
- *Storing anything a regulator would call personal data.* See the constraint above.

## File Structure

- `apps/api/prisma/schema.prisma` + migration — `Subscription`, `SubscriptionStatus`, `ProcessedWebhookEvent`.
- `apps/api/src/billing/entitlement.service.ts` — the projection and its grace window. Pure logic, no network.
- `apps/api/src/billing/billing.service.ts` — apply a subscription state change; create a checkout link.
- `apps/api/src/billing/lemon-squeezy.adapter.ts` — the only file that knows the provider.
- `apps/api/src/billing/billing.controller.ts` — checkout, and the webhook endpoint.
- `apps/api/src/billing/billing-reconcile.job.ts` — on the existing tick.
- `apps/web/src/routes/Premium.tsx` + test.

---

### Task 1: What being subscribed means

**Files:** schema + migration, `entitlement.service.ts`, `apps/api/test/entitlement.int-spec.ts`

**Interfaces:**
- Produces: `EntitlementService.applyTo(userId, subscription)` → writes `User.premiumUntil`.

- [x] **Step 1: Write the failing tests**

```ts
it('grants premium to the end of the paid period', async () => { ... });

it('keeps premium through a grace window when a payment fails', async () => {
  // A card that expired on Tuesday is not a reader who stopped paying. Revoking mid-retry is a
  // worse experience than the retry succeeding a day later.
  await apply({ status: 'PAST_DUE', currentPeriodEnd: yesterday });
  expect(await isPremium(user)).toBe(true);
});

it('revokes once the grace window has passed', async () => { ... });

it('revokes immediately when a subscription is refunded', async () => {
  // Not the same as lapsing: the money went back, so the entitlement goes with it and no grace
  // applies. A grace window on a refund is a window for buying premium and taking it back.
  await apply({ status: 'REFUNDED', currentPeriodEnd: nextMonth });
  expect(await isPremium(user)).toBe(false);
});

it('keeps premium to the period end when cancelled', async () => {
  // Cancelling stops the renewal; it does not take back the month already paid for.
  await apply({ status: 'CANCELLED', currentPeriodEnd: nextMonth, cancelAtPeriodEnd: true });
  expect(await isPremium(user)).toBe(true);
});

it('never shortens premium somebody already has', async () => {
  // Two events can arrive out of order — providers do not promise ordering. Taking the later of
  // the two dates means a stale event cannot revoke a renewal that already landed.
  ...
});
```

- [x] **Step 2–5:** Run to see them fail; implement; run; **mutation-check** — dropping the grace window, applying grace to a refund, letting an out-of-order event shorten entitlement.
- [x] **Step 6: Commit.**

### Task 2: Webhooks, verified and exactly once

**Files:** `lemon-squeezy.adapter.ts`, `billing.service.ts`, `billing.controller.ts`, `apps/api/test/billing-webhook.int-spec.ts`

- [x] **Step 1: Failing tests**

```ts
it('refuses an unsigned request', async () => { ... 401 ... });
it('refuses a request whose signature does not match the raw body', async () => {
  // Signed over the exact bytes: re-serializing JSON changes them, which is why main.ts keeps
  // rawBody. A handler that verifies the parsed body verifies nothing.
});
it('processes a subscription_created event and grants premium', async () => { ... });
it('processes the same event id twice as once', async () => {
  // Providers retry on any non-2xx and on timeouts. Without this, a retry after a slow response
  // extends entitlement a second time.
});
it('returns 2xx for an event type it does not handle', async () => {
  // A 4xx makes the provider retry forever and eventually disable the endpoint.
});
it('records the event before acting on it, so a crash mid-handler does not double-apply', ...);
```

- [x] **Step 2–5:** Run; implement with `@RequireRawBody`-style verification mirroring `webhook-signature.service.ts`; run; **mutation-check** — accepting an unsigned request, verifying the parsed body instead of raw bytes, dropping the idempotency check, returning 4xx for unknown types.
- [x] **Step 6: Commit.**

### Task 3: Buying it

**Files:** `billing.controller.ts` (checkout), `apps/web/src/routes/Premium.tsx` + test

- [x] **Step 1: Failing tests** — a signed-in reader gets a checkout URL carrying their user id as the provider's custom data; an anonymous one is refused; the URL is never built from client-supplied data; the page shows current status and a manage link when subscribed.
- [x] **Step 2–5:** Run, implement, run, **mutation-check** — trusting a client-supplied user id, granting entitlement on the return redirect.
- [x] **Step 6: Commit.**

### Task 4: When the webhook never arrives

**Files:** `billing-reconcile.job.ts`, wired into the existing tick

- [x] **Step 1: Failing tests** — a subscription past its period end with no renewal event is re-checked against the provider; a provider error leaves entitlement alone rather than revoking; the batch is bounded.
- [x] **Step 2–5:** Run, implement, run, **mutation-check** — revoking on a provider error is the one that matters.
- [x] **Step 6: Commit.**

## What it found

**The CSRF exemption had to be an exact path, not a namespace.** `/billing/checkout` sits beside
the webhook, is session-authenticated, and needs the token like anything else — a `/billing/`
prefix would have quietly left a mutating endpoint open to a cross-site post. The test for it was
too loose at first: "not 200" passes whether the rejection is CSRF's 403 or the session guard's
401, so it now asserts 403 exactly.

**The idempotency pre-check is not what guarantees exactly-once** — the primary key is. A mutation
removing the read alone changed nothing, because the unique violation path catches it; removing
both makes the redelivery throw and the test notices. The comment now says which is which.

**Coverage found that checkout had no tests at all**, including the property that the user id
comes from the session rather than the request body. That one matters: taking it from the body
would let anyone pay once and name somebody else.

**An anonymous checkout request is 403, not 401.** The CSRF token is session-bound, so it cannot
be produced without a session and the request never reaches the guard. Asserting 401 would have
been asserting a route that does not exist.

## Known risks

- **This is the first code path where a bug costs somebody money**, or costs us a reader's trust. Every other failure in this project loses a suggestion.
- **Testing against a live provider is not possible in CI.** The adapter is faked at its boundary and the contract with the real provider rests on a sandbox run done by hand — which is the weakest link here, and worth saying out loud rather than discovering later.
- **Clock skew and time zones.** `premiumUntil` is compared against `new Date()` in five places already; a provider sending a period end in a different representation would be silently wrong rather than loudly.
- **A refund after entitlement was consumed** is not recoverable — they had the palette for a month. Accepted: the alternative is holding entitlement back until the refund window closes, which punishes everybody for a rare case.
