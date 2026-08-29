# Testing a real purchase

Everything in `apps/api/src/billing/` is tested against payloads I wrote. That proves the adapter
is self-consistent; it proves nothing about whether it matches what Lemon Squeezy actually sends.
One sandbox purchase settles that, and it is the only step nobody has done.

If the shape differs, the adapter **fails closed** — `parse` returns null, no entitlement is
granted — but it does so silently. That is the reason this is not optional.

## 1. In Lemon Squeezy

- Create a store, and a **subscription** product with a monthly variant.
- Turn on **Test mode** (the toggle in the dashboard). Test mode has its own API keys and its own
  webhook endpoints; nothing here touches real money.
- Settings → Webhooks → add an endpoint pointing at `https://<your-host>/api/v1/billing/webhook`,
  with a signing secret you choose. Subscribe it to the `subscription_*` events.
- Settings → API → create a key.

## 2. Configure the API

```
LEMONSQUEEZY_WEBHOOK_SECRET=<the signing secret you chose>
LEMONSQUEEZY_CHECKOUT_URL=<the product's checkout URL>
LEMONSQUEEZY_API_KEY=<the test-mode API key>
```

All three are optional as a set. Without them the app runs exactly as it does now — nobody is
premium, every gate stays closed, and the webhook refuses because it has no secret to verify
against.

## 3. Reaching a local API

Lemon Squeezy has to be able to POST to you. If the API is on your machine, put a tunnel in front
of it and use the tunnel's URL as the webhook endpoint.

## 4. Buy it

Sign in, go to `/premium`, press Subscribe. You are sent to Lemon Squeezy's own hosted checkout —
no card field exists in this application, which is most of what a merchant of record is for. Use
their published test card.

## 5. Check what happened

```sql
SELECT "userId", status, "currentPeriodEnd" FROM "Subscription";
SELECT "patreonUserId", "premiumUntil" FROM "User" WHERE "premiumUntil" IS NOT NULL;
```

Then reload `/premium`: it should show Active with a renewal date, and the premium half of the
reaction palette should be selectable on any board.

## If the webhook did not land

The dashboard shows every delivery with its response. Then:

```bash
cd apps/api
pnpm tsx scripts/verify-lemonsqueezy.ts ./body.json '<X-Signature>' '<secret>'
```

Copy the body to a file **exactly as sent** — reformatting the JSON changes the bytes and the
signature will not match, which is the check working rather than failing.

- `signature: INVALID` → the secret differs, or the body was altered in copying.
- `parse: NULL` → the payload shape differs from what the adapter expects. It prints nothing more
  because it has nothing more; compare it against `lemon-squeezy.adapter.ts` and fix the mismatch.

## What is still not covered after this

- **`order_refunded` is not handled.** A refund normally also moves the subscription to
  `cancelled` or `expired`, which is handled — but a refund that leaves the subscription untouched
  will not revoke until the period ends.
- **Cancelling happens on Lemon Squeezy's side**, from the link in their receipt email. There is
  no cancel button in this application, which is normal for a merchant-of-record setup and keeps
  this app out of the payment flow entirely.
- **Reconciliation reads the subscriptions API**, and that response shape has not been seen either.
  It fails closed the same way: an unrecognised response leaves entitlement alone.
