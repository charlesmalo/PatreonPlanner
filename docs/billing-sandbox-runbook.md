# Testing a real purchase

Everything in `apps/api/src/billing/` is tested against payloads I wrote. That proves the adapter
is self-consistent; it proves nothing about whether it matches what Lemon Squeezy actually sends.
One sandbox purchase settles that, and it is the only step nobody has done.

If the shape differs, the adapter **fails closed** — `parse` returns null, no entitlement is
granted — but it does so silently. That is the reason this is not optional.

> **You do not need any of this to see premium work.** Set `BILLING_PROVIDER=fake` and the whole
> journey is reachable with no merchant account: subscribe, get entitled, see the receipt, fail a
> renewal, get refunded, lose it. See *The provider that takes no money* below. What that cannot
> tell you is whether Lemon Squeezy's real payload matches what the adapter expects — which is
> the one question this page exists for.

## The provider that takes no money

`BILLING_PROVIDER` selects the implementation. Both satisfy the same `PaymentProvider` port and
both pass `test/payment-provider-conformance.e2e-spec.ts`, which is the gate any future provider
walks through.

| | |
| --- | --- |
| `lemonsqueezy` | The default. Unconfigured, it sells nothing and refuses every webhook — which is the right state for development and for anybody self-hosting who does not want to sell anything. |
| `fake` | Serves its own checkout stand-in at `/api/v1/billing/fake-checkout`. Pressing a button there signs a payload and posts it at the **real** webhook route, so a fake purchase runs signature verification, the idempotency key, the parse, the subscription upsert and the entitlement projection. |

It takes two keys to run the fake anywhere `NODE_ENV=production`, and the boot **aborts** with an
explanation if only the first is set:

```
BILLING_PROVIDER=fake
ALLOW_FAKE_BILLING_IN_PRODUCTION=true
```

Two rather than one because a single variable is a typo away from giving the product away. Both
container stacks in this repo need both, because a production image sets `NODE_ENV=production` as
it should — the first attempt at wiring the demo refused to boot for exactly this reason, which is
the guard working rather than a nuisance.

`API_PUBLIC_URL` must be the address a **browser** can reach the API on, since the stand-in is a
page somebody navigates to. In both compose stacks that is the web origin, because nginx serves
the SPA and proxies `/api/` from the same host.

## Switching back to the real provider

Delete `BILLING_PROVIDER` (or set it to `lemonsqueezy`) and `ALLOW_FAKE_BILLING_IN_PRODUCTION`,
then configure the three Lemon Squeezy variables below. Nothing else changes: no code, no
migration, no data. Subscriptions and receipts written by the fake keep `provider = 'fake'`, so
they stay attributable rather than being mistaken for real money afterwards.

## 1. In Lemon Squeezy

- Create a store, and a **subscription** product with a monthly variant.
- Turn on **Test mode** (the toggle in the dashboard). Test mode has its own API keys and its own
  webhook endpoints; nothing here touches real money.
- Settings → Webhooks → add an endpoint pointing at `https://<your-host>/api/v1/billing/webhook`,
  with a signing secret you choose. Subscribe it to the `subscription_*` events.
- Settings → API → create a key.

## 2. Configure the API

Put the three secrets in `.env` at the repo root, which is gitignored:

```
LEMONSQUEEZY_WEBHOOK_SECRET=<the signing secret you chose>
LEMONSQUEEZY_CHECKOUT_URL=<the product's checkout URL>
LEMONSQUEEZY_API_KEY=<the test-mode API key>
```

Then bring the demo stack up with the override that reads them:

```bash
docker compose -p patreonplanner-demo \
  -f docker-compose.demo.yml -f docker-compose.lemonsqueezy.yml up -d
```

That file switches `BILLING_PROVIDER` back to `lemonsqueezy` and holds no secrets itself, so it is
committed while `.env` is not. Compose **refuses to start** if any of the three is missing rather
than booting an instance that silently cannot sell.

All three are optional as a set. Without them the app runs exactly as it does now — nobody is
premium, every gate stays closed, and the webhook refuses because it has no secret to verify
against.

## 3. Reaching a local API

Lemon Squeezy has to be able to POST to you, so the webhook route needs a public address:

```bash
cloudflared tunnel --url http://localhost:8081
```

Use the printed `https://….trycloudflare.com` as the webhook endpoint's host. It lasts as long as
that command runs.

**Only the webhook needs it.** You still browse the app at `localhost:8081`, and `WEB_ORIGIN` and
`PATREON_REDIRECT_URI` stay as they are — pointing them at the tunnel would break the OAuth
redirect for no gain. `API_PUBLIC_URL` is read solely by the fake provider's checkout stand-in,
which this configuration switches off, so it is irrelevant here.

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

- **`order_refunded` is handled**, matched on the order id — a refund names an order and nothing
  else, since subscriptions carry an `order_id` and not the reverse. Two limits stand: a
  subscription created before the order id was recorded cannot be matched until some later event
  backfills it, and **a partial refund may set the same `refunded` flag as a full one**, in which
  case entitlement would be revoked outright. Worth checking against a real partial refund before
  it matters.
- **Cancelling happens on Lemon Squeezy's side**, from the link in their receipt email. There is
  no cancel button in this application, which is normal for a merchant-of-record setup and keeps
  this app out of the payment flow entirely.
- **Reconciliation reads the subscriptions API.** Its shape is now checked against their
  documentation the same way the webhook's was — `billing-adapter.e2e-spec.ts` parses a
  documented retrieve response — but no real response has been seen. It fails closed either way:
  an unrecognised one leaves entitlement alone rather than revoking.
