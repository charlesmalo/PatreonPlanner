# Turning on email digests

Digests are off until three things are configured, and the app runs perfectly well without them —
nobody receives anything and nothing fails.

```
RESEND_API_KEY=<from resend.com>
DIGEST_FROM=PatreonPlanner <digest@yourdomain>
WEB_ORIGIN=https://yourdomain      # already set; the unsubscribe link is built from it
```

## The part that is not a config value

**A sending domain with SPF and DKIM.** Resend gives you the DNS records; until they are in place
and verified, digests go to spam and the free tier is spent on mail nobody reads. `DIGEST_FROM`
must be an address on that domain — a `@gmail.com` sender will be rejected outright.

This needs DNS access and cannot be done from the codebase.

## What the free tier actually buys

**3,000 emails a month, 100 a day.** One digest per reader per day means the ceiling is about
**100 opted-in readers**. Past that is the first recurring bill this project would carry.

Per-event email would have been one message per follower per move, which is why Amendment A.4
chose a digest before anyone knew who the provider would be.

## Checking it works

1. Opt in on `/c/<board>/notifications` — it is off for everybody by default.
2. Make sure there is something to report: move an entry on a board you follow, and check the bell
   shows it. The digest carries exactly what the bell would have; if the bell is empty the digest
   is not sent, deliberately.
3. Trigger the tick, or call `DigestService.runOnce()` directly.
4. The email lists what moved and ends with an unsubscribe link. Follow it — it must work with no
   session, from a mail client.

## What is not built

- **Bounce and complaint handling.** Providers suspend senders who ignore them. Fine at a hundred
  a day; not fine after, and it needs their webhook — which is the same unverified-contract
  problem billing had, so it is not guessed at here.
- **HTML.** The digest is plain text: a list of what moved with an unsubscribe link. Anything
  richer needs a template system and a way to preview it.
- **Anything other than board moves.** Reports, tickets and status changes on your own entries
  stay in the bell. The digest is for news about boards you follow.

## The contract is unverified

The shape of a send request is read from Resend's documentation, not from a response anybody has
seen — exactly the position billing was in before its sandbox run. A mismatch throws, the watermark
stays where it is, and tomorrow's digest still carries today's news. It fails loudly here rather
than silently, which is the one advantage this has over the billing case.

## Bounces and complaints

Mailbox providers judge a sender on whether it keeps mailing people who bounced or complained, and
suspend the ones that do. Resend reports both.

In the dashboard: **Webhooks → add an endpoint** at `https://<your-host>/webhooks/resend`,
subscribed to `email.bounced` and `email.complained`. Copy the signing secret it gives you:

```
RESEND_WEBHOOK_SECRET=whsec_...
```

Without it the endpoint refuses every delivery — which is correct for an instance that sends no
mail, since this endpoint can stop mail reaching a reader and an unverified one would be a denial
of service with a `curl`.

A suppressed address is refused **in the sender**, not in the digest, so anything this application
ever sends inherits the check rather than each caller having to remember it.

### What suppresses, and what does not

| | |
| --- | --- |
| `email.complained` | Always. Being marked as spam is the most expensive signal a sender gets, and there is no temporary version of it. |
| `email.bounced` with `bounce.type: "Permanent"` | Yes — the address is wrong. |
| `email.bounced` with a temporary type | **No.** A full mailbox or a greylisting server is not a wrong address, and suppressing on one loses a reader who did nothing. |
| A bounce type nobody has seen before | **No.** Guessing towards suppression costs a reader silently and permanently; guessing away from it costs one more bounce, which the next delivery reports again. |

### The one unverified part

The signature check implements Svix's scheme — Resend signs `id.timestamp.body` with the base64
secret after the `whsec_` prefix — from their published description rather than against a real
delivery. It **fails closed**, so a mismatch means bounces go unrecorded, never that a stranger can
suppress an address. Send one test webhook from the dashboard and confirm it answers `200` before
relying on it.
