# Payment Provider Black Box Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every payment provider behind one interface, and ship a fake implementation of it that
carries a purchase all the way to entitlement — so the whole product can be demonstrated end to end
before anybody has a merchant account.

**Architecture:** A `PaymentProvider` port with two implementations behind a DI token. `LemonSqueezyAdapter`
keeps every line it has and gains the one method that was living in the controller. `FakePaymentProvider`
serves its own hosted-checkout stand-in, and that stand-in signs a real payload and posts it at the real
webhook path — so a fake purchase exercises signature verification, idempotency, the subscription upsert
and the entitlement projection, rather than skipping to the answer. Swapping providers is a config value.

**Tech Stack:** NestJS 10, Prisma 5.20 + Postgres 16, Jest + Testcontainers, React 18 + Vite, Vitest + RTL.

## Global Constraints

- Every dependency must be free. This plan adds **no** new dependency to any package.json.
- **No billing PII, ever.** Provider references and amounts only: no name, no email address, no
  postal address, no card brand, no last four. This is the constraint that decides the `PaymentReceipt`
  columns, and `parse` already refuses the PII Lemon Squeezy offers it.
- The fake provider must be impossible to enable by accident in production. See Task 6.
- `pnpm -r test` does not typecheck. Verification means `pnpm -r typecheck` **and** `pnpm -r test`.
- Never edit an applied migration — Prisma checksums it.

---

## Decisions taken before writing this

**The demo runs locally now and hosted later**, so the fake is gated by two keys rather than
hard-refused: selecting it under `NODE_ENV=production` aborts the boot unless
`ALLOW_FAKE_BILLING_IN_PRODUCTION=true` is *also* set. Default off, and a banner on every boot that
has it on. One key is a typo away from free premium; two is a decision.

**A fake purchase goes the whole way.** The fake serves its own checkout stand-in, and pressing Pay
signs a payload and posts it at the real webhook route. Signature verification, idempotency, the
subscription upsert and the entitlement projection all execute. The alternative — granting
entitlement directly — would demo the outcome while skipping every line that has ever had a bug in
it. Eight of the nine billing defects so far were in exactly that plumbing.

**The fake speaks its own dialect on purpose.** Its payload is *not* shaped like Lemon Squeezy's:
different envelope, different field names, seconds-since-epoch instead of ISO strings. A fake that
mirrors the real payload would let provider assumptions leak through the port while every test still
passed. If both implementations satisfy the conformance suite in Task 7 while disagreeing about
wire format, the seam is real.

## File Structure

| File | Responsibility |
| --- | --- |
| `billing/payment-provider.ts` | The port: interface, DI token, shared event types. Knows no provider. |
| `billing/lemon-squeezy.adapter.ts` | Lemon Squeezy's dialect. Gains `checkoutUrlFor`. |
| `billing/fake/fake-payment-provider.ts` | The stand-in's dialect, and the signing key it shares with its checkout page. |
| `billing/fake/fake-checkout.controller.ts` | The hosted-checkout stand-in. Only mounted when the fake is selected. |
| `billing/webhook-ingest.service.ts` | verify → parse → apply, in one place, so the real route and the stand-in cannot drift. |
| `billing/receipt.service.ts` | Writing and reading receipts. |
| `billing/billing.module.ts` | Chooses the implementation and refuses the unsafe combination. |

---

### Task 1: The port, with Lemon Squeezy behind it

**Files:**
- Create: `apps/api/src/billing/payment-provider.ts`
- Modify: `apps/api/src/billing/lemon-squeezy.adapter.ts`, `billing.controller.ts`, `billing-reconcile.job.ts`, `billing.module.ts`
- Test: `apps/api/test/payment-provider-port.e2e-spec.ts`

**Interfaces — Produces:**

```ts
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export interface PaymentProvider {
  readonly provider: string;
  /** Where to send somebody who wants to subscribe, or null if this instance cannot sell. */
  checkoutUrlFor(userId: string): string | null;
  verify(rawBody: Buffer, signature: string | undefined, secret: string): boolean;
  /** The secret `verify` should be given, or undefined when the provider is not configured. */
  signingSecret(): string | undefined;
  idempotencyKey(rawBody: Buffer): string;
  parse(body: unknown): SubscriptionEvent | null;
  parseRefund(body: unknown): RefundEvent | null;
  fetchSubscription(id: string): Promise<SubscriptionEvent | null>;
}
```

`signingSecret()` moves onto the port deliberately: the controller currently reads
`LEMONSQUEEZY_WEBHOOK_SECRET` itself, which is the one remaining place outside the adapter that
names a provider.

- [ ] **Step 1:** Write `payment-provider-port.e2e-spec.ts` asserting `LemonSqueezyAdapter` satisfies every
      member of the port, and that `checkoutUrlFor` appends `checkout[custom][user_id]`.
- [ ] **Step 2:** Run it. Expect FAIL — `checkoutUrlFor` does not exist.
- [ ] **Step 3:** Add `checkoutUrlFor` and `signingSecret` to the adapter, moving the body of
      `BillingController.checkout` and the secret read verbatim.
- [ ] **Step 4:** Point the controller and reconcile job at `@Inject(PAYMENT_PROVIDER)`.
- [ ] **Step 5:** Run `pnpm --filter api test` and `pnpm -r typecheck`. Both green.
- [ ] **Step 6:** Commit `refactor(billing): a port the provider sits behind`.

### Task 2: One ingest path

**Files:**
- Create: `apps/api/src/billing/webhook-ingest.service.ts`
- Modify: `billing.controller.ts`, `billing.module.ts`
- Test: `apps/api/test/billing-webhook.int-spec.ts` (existing — must stay green untouched)

**Interfaces — Produces:**

```ts
type IngestResult = { ok: true; handled: boolean } | { ok: false; reason: 'unsigned' | 'unverified' };
async ingest(rawBody: Buffer, signature: string | undefined): Promise<IngestResult>
```

Returning a reason rather than throwing: the stand-in in Task 4 needs to render a decline, and an
`UnauthorizedException` thrown three layers down is not a thing a page can render.

- [ ] **Step 1:** Move the body of `BillingController.webhook` into `ingest`, translating each throw
      into a reason. The controller re-throws so its HTTP contract is byte-for-byte unchanged.
- [ ] **Step 2:** Run the existing webhook suite. It must pass **without edits** — if it needs
      changing, behaviour moved, which this step is not allowed to do.
- [ ] **Step 3:** Commit `refactor(billing): one path from payload to entitlement`.

### Task 3: The fake provider

**Files:**
- Create: `apps/api/src/billing/fake/fake-payment-provider.ts`
- Test: `apps/api/test/fake-payment-provider.e2e-spec.ts`

Its dialect, chosen to share nothing with Lemon Squeezy's:

```jsonc
{
  "kind": "subscription.activated",       // not meta.event_name
  "sub": "fake_sub_01",                   // not data.id
  "buyer": "<uuid>",                      // not meta.custom_data.user_id
  "order": "fake_ord_01",
  "state": "live",                        // not "active"
  "period_ends": 1789000000,              // seconds, not an ISO string
  "will_renew": true,
  "paid": { "cents": 500, "currency": "USD" }  // receipts, which LS carries elsewhere
}
```

**Status map:** `live → ACTIVE`, `dunning → PAST_DUE`, `stopping → CANCELLED`, `dead → EXPIRED`,
`clawed_back → REFUNDED`. Anything else returns null, for the same reason the real one does: an
unmapped status must never become ACTIVE.

- [ ] **Step 1:** Tests first — one per row of that map, plus: unknown state → null, missing
      `period_ends` → null, non-object body → null, `null` body → null, wrong signature → false,
      and `idempotencyKey` stable across two identical buffers and different across differing ones.
- [ ] **Step 2:** Run. Expect FAIL — the file does not exist.
- [ ] **Step 3:** Implement. `verify` and `idempotencyKey` are the same HMAC/SHA-256 shape as the
      real one; everything else is its own.
- [ ] **Step 4:** Green. Commit `feat(billing): a payment provider that takes no money`.

### Task 4: The checkout stand-in

**Files:**
- Create: `apps/api/src/billing/fake/fake-checkout.controller.ts`
- Test: `apps/api/test/fake-checkout.int-spec.ts`

`GET /api/v1/billing/fake-checkout?user_id=…` renders a small self-contained HTML page — no assets,
no script from anywhere — with four buttons. Each POSTs back, and the handler builds the payload,
signs it with the fake's secret, and hands it to `WebhookIngestService.ingest`, then redirects to
`${WEB_ORIGIN}/premium`.

| Button | What it proves |
| --- | --- |
| Pay | The happy path, end to end, including the receipt |
| Decline | Nothing is granted, and the page says why |
| Renewal fails | `PAST_DUE`, and the five-day grace window |
| Refund | Immediate revocation with no grace |

- [ ] **Step 1:** Integration tests: pay → `premiumUntil` in the future and one `Subscription` row;
      pay twice with the same payload → still exactly one `ProcessedWebhookEvent`; decline → no
      subscription row and `premiumUntil` still null; refund after pay → `premiumUntil` null.
- [ ] **Step 2:** Run. Expect FAIL — route not found.
- [ ] **Step 3:** Implement. The `user_id` comes from the query string and is **never** trusted for
      anything but building the payload — the same webhook path re-checks that the user exists.
- [ ] **Step 4:** Green. Commit `feat(billing): a checkout page that charges nobody`.

### Task 5: Receipts

**Files:**
- Create: `apps/api/prisma/migrations/<ts>_payment_receipt/migration.sql`, `billing/receipt.service.ts`
- Modify: `schema.prisma`, `billing.service.ts`, `billing.controller.ts`, `apps/web/src/routes/Premium.tsx`
- Test: `apps/api/test/billing-receipts.int-spec.ts`, `apps/web/src/routes/Premium.test.tsx`

```prisma
model PaymentReceipt {
  id                String   @id @default(uuid()) @db.Uuid
  userId            String   @db.Uuid
  provider          String
  // The provider's reference, and the whole of what we keep about the transaction.
  providerReceiptId String
  providerOrderId   String?
  amountCents       Int
  currency          String   @db.VarChar(3)
  paidAt            DateTime
  // Provider-hosted. Null for a provider that does not host one.
  url               String?
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([provider, providerReceiptId])
  @@index([userId, paidAt])
}
```

There is deliberately no name, email, address, card brand or last four on this model. A receipt row
answers "what did this account pay, and where do I go to see the real one" — everything else stays
with the merchant of record.

- [ ] **Step 1:** Test that paying writes exactly one receipt, that replaying the same payment writes
      no second one, and that `GET /billing/receipts` returns only the caller's own.
- [ ] **Step 2:** Run. FAIL. **Step 3:** Migrate and implement. **Step 4:** Green.
- [ ] **Step 5:** Premium page lists them. Commit `feat(billing): receipts, without the person on them`.

### Task 6: Selection, and the guard

**Files:** `config/config.schema.ts`, `billing/billing.module.ts`
**Test:** `apps/api/test/billing-provider-selection.e2e-spec.ts`

```ts
BILLING_PROVIDER: z.enum(['none', 'fake', 'lemonsqueezy']).default('none'),
ALLOW_FAKE_BILLING_IN_PRODUCTION: z.enum(['true','false']).default('false').transform(v => v === 'true'),
FAKE_BILLING_SECRET: z.string().min(1).default('fake-billing-secret'),
```

- [ ] **Step 1:** Test that `fake` + `production` + flag unset **throws at module construction**, that
      the same with the flag set constructs, and that `none` leaves checkout unavailable.
- [ ] **Step 2:** FAIL. **Step 3:** Implement as a factory provider that throws. **Step 4:** Green.
- [ ] **Step 5:** Commit `feat(billing): two keys to fake a payment in production`.

### Task 7: The conformance suite

**Files:** `apps/api/test/payment-provider-conformance.e2e-spec.ts`

The point of the whole plan: one `describe.each` over both implementations, asserting the contract
every provider owes regardless of dialect — a valid payload round-trips, an unmapped status is null,
a `null` body is null, a tampered byte fails `verify`, the same bytes give the same idempotency key,
and a cancelled subscription reports the date access *ends* rather than the renewal that will not
happen. When Lemon Squeezy is wired for real, or replaced, this is the gate.

- [ ] **Step 1:** Write it. **Step 2:** Both implementations pass, or the one that does not is wrong.
- [ ] **Step 3:** Commit `test(billing): the contract both providers owe`.

### Task 8: Demo wiring and docs

**Files:** `docker-compose.demo.yml`, `e2e/tests/journey.spec.ts`, `docs/billing-sandbox-runbook.md`, `docs/demo-walkthrough.md`, `coding_agent/PROGRESS_TRACKER.md`

- [ ] **Step 1:** Demo stack sets `BILLING_PROVIDER=fake`. An e2e leg buys premium and sees a
      premium-only control unlock.
- [ ] **Step 2:** Runbook gains a section on switching back to the real provider.
- [ ] **Step 3:** Commit `feat(demo): premium you can actually buy in the demo`.
