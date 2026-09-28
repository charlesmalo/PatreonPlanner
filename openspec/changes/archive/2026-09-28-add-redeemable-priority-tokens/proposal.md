## Why

The board ranks by weighted votes, so a high tier buys *influence over an average* and nothing a
patron can point at. A Producer who wants one specific thing played next has no move except to
upvote harder and hope. Redeemable tokens give the top tiers a small, countable, spendable thing —
and give a creator a way to thank a moderator that costs money rather than words.

The property driving every decision below: **a token is a promise the creator has to keep**. That
makes it different from a vote, which only ever nudges an ordering. A vote that achieves nothing is
a disappointment; a token that achieves nothing is a refund request.

## What Changes

- A creator may turn on **redeemable tokens** for their board. Off by default, per creator, and
  invisible everywhere until they do.
- Each **tier** gets a grant: N tokens per billing period. Zero for every tier until set, so
  turning the feature on grants nothing until the creator says who gets what.
- A creator may **grant tokens directly** to a reader — a bonus to a tier, or a thank-you to a
  moderator, who need not be a patron at all.
- A patron **spends** a token on an entry that is already `ACCEPTED`, with a short note naming
  what they want — an episode, a chapter, a specific video. The note is free text, not a
  catalogue reference; see the *Out* section.
- An entry carrying at least one unspent redeem shows a **Priority** marker and its redeem count.
  Redeems **stack**: three patrons redeeming the same entry is a count of three.
- Priority is **not** a new column and does not change the status lifecycle. An entry stays
  `ACCEPTED`; Priority is a marker on it, and the Accepted column sorts Priority entries first.
- A redeem is **consumed** when the creator moves that entry to `ACTIVE`. Unconsumed tokens never
  expire.
- Both the grant and the spend are recorded in a **ledger**, because a balance nobody can audit is
  a balance nobody can argue with.

Not breaking. Every existing board behaves exactly as it does today with the feature off, which is
how every board starts.

## Capabilities

### New Capabilities

- `redeemable-tokens`: what a token is, who is granted one and when, what spending one does to an
  entry, when it is consumed, and what a reader may see of somebody else's balance.

### Modified Capabilities

None. The board's status lifecycle, weighted voting and moderation rules are unchanged — Priority
is a marker read alongside them, not a new state within them. The Accepted column's *ordering*
changes only for boards that turn the feature on, which the new capability describes.

## Impact

- **Schema**: `CreatorPolicy` gains the opt-in and the period; `Tier` gains a per-period grant;
  three new tables — a balance per reader per creator, a grant/spend ledger, and the redeem itself.
- **API**: token balance and ledger reads, a spend endpoint, creator grant endpoints, and the
  redeem count on the board's entry projection.
- **Web**: a Priority marker and count on the card, a spend control on an accepted entry, a
  balance somewhere the patron can find it, and a settings section for the creator.
- **Billing**: none. Tokens are granted from Patreon tier membership the board already syncs;
  nothing is bought with money inside this product, and the fake payment provider is untouched.
- **Notifications**: a redeemed entry reaching `ACTIVE` is already a notifiable move; whether the
  redeemer is told *specifically* is a question for the spec.

## Out, with reasons

- **Real episodes.** The note is free text. Nothing in this system models an episode — a
  `WatchOrderItem` is a hand-ordered list of *titles*, and no table tracks watched state per
  episode. "The next unwatched episode" would mean a TMDB episode sync, an `Episode` table, a
  per-episode watched UI and a job to keep it fresh. That is a larger feature than this one, and
  this one works without it: the creator reads "S2E04" and plays S2E04.
- **Expiring tokens.** "Use them or lose them" creates urgency and destroys something a patron
  paid for while they were on holiday. Tokens are kept.
- **Redeeming anything not yet accepted.** A redeem on a `PENDING` entry would let money skip
  moderation, which is the one thing the queue exists to prevent.
- **Refunds and declines.** No decline flow. A creator who will not play something can leave it;
  the token stays spent on an entry that stays Priority. Adding a decline invites an argument
  about what counts as declining, and that argument is worse than the gap.
- **Tokens purchasable with money.** Tokens come from tier membership and creator generosity only.
  Selling them directly makes this a payments feature and a refunds liability.

## What an existing user notices

**Nothing, on a board whose creator leaves this off** — which is every board, until one opts in.
No new column, no new control, no reordering.

On a board that turns it on: the Accepted column may reorder, because Priority entries lead. That
is the intended effect and the only regression-shaped change here — a reader who knew their entry
sat third in Accepted may find it fourth, behind something redeemed. The spec says how loudly the
column should say so.
