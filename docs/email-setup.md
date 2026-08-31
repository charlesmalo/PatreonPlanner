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
