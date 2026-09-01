# Playing with it

```bash
docker compose -p patreonplanner-demo -f docker-compose.demo.yml up -d --build
```

Web on **http://localhost:8081**. Sign in by choosing who to be at **http://localhost:4001/__be** —
that sets the identity and drops you into the real OAuth flow, so the demo exercises the same
login path as everything else rather than a shortcut around it.

The background tick runs every **15 seconds** here rather than the deployed fifteen minutes, so
queued work resolves while you are watching it.

**Premium is buyable here**, with no merchant account and no card. The stack runs a payment
provider that takes no money — see *Buying premium* below.

## Who you can be

| | |
| --- | --- |
| **Ada** | owns *Ada Watches Things*. Moves entries, decides links, sees the review queue. |
| **Mo** | moderates Ada's board and owns *Mo Reads Things*. |
| **Bea** | patron of both, $5. Narrowed her news to **Anime**. |
| **Cal** | patron of both, $15, **and the only one with premium**. Narrowed to *Documentary*, but follows one Anime entry anyway. |
| **Dee** | lapsed. Can read, cannot submit — the split is invisible if everyone can do everything. |

## Things worth trying, roughly in order

**A link waits for a human.** As Bea, look at *Princess Mononoke* on Ada's board: one link shows,
one does not. Sign in as Ada — the second appears as a candidate with Publish and Discard beside
it. That is the whole point of the model: a patron's link is a claim, not the creator's
endorsement, until somebody says so.

**Premium is a real gate.** As Cal, react to anything with 🍿. As Bea, try the same emote — the
control is disabled and says why. Then look at an emote somebody already used: it still shows,
with its count, for everyone. Reading is never gated, or a count would vanish the day somebody
stopped paying.

**Carrying a list across boards.** As Cal, go to `/carry-over`. Pick *My Neighbor Totoro* and send
it to *Mo Reads Things*. Within about fifteen seconds the dashboard says **Suggested**, and the
entry is on Mo's board. Send *Piranesi* as well: that one comes back **Already on that board**,
and offers an upvote rather than casting one for you.

**Who hears about a move.** As Ada, move *Perfect Blue* to Now Playing. Bea's bell rings — it is
Anime, and she asked for Anime. Now move something untagged: silence, because themes hang off a
catalogue title and a hand-typed entry has none. That is the cost of reusing the creator's
vocabulary and it is why the settings page says so.

**A follow beats the narrowing.** Cal narrowed to *Documentary*, so nothing on Ada's board should
reach him. Move *Princess Mononoke* — it does, because he follows that one entry. Statuses answer
*what counts as news*; a follow answers *about what*, and it is the most specific answer there is.

**Tidying is one piece of news.** Move three entries to Now Playing in a row. Bea gets **one**
bell item saying "and 2 other changes", not three.

## What the demo cannot show

- **Buying premium.** No payment provider is configured, so `/premium` says subscriptions are not
  available and shows Cal's seeded subscription instead. `docs/billing-sandbox-runbook.md` is the
  real thing.
- **Email digests.** No provider key, so the digest job logs what it would have sent rather than
  sending it. `docs/email-setup.md`.
- **Anything from TMDB.** The catalogue is stubbed; searching finds the stub's fixtures.

## Starting over

```bash
docker compose -p patreonplanner-demo -f docker-compose.demo.yml down -v
```

The volume is kept between runs otherwise, so a playtester who restarts finds their board where
they left it. The seed is idempotent — running it twice changes nothing.

## Buying premium

Go to **/premium** and press **Subscribe**. That lands on a deliberately ugly stand-in for the
payment provider's own page, with a button for each thing a subscription can do:

| | |
| --- | --- |
| **Pay $5.00** | Entitled immediately, with the payment listed under *Payments* on the premium page. |
| **Card declined** | Nothing recorded at all — a declined card never reaches the merchant's webhook, so there is no subscription and no receipt. |
| **Pay, then let the renewal fail** | `PAST_DUE`. Access continues through a five-day grace window, because a failed card is usually a card that needs updating rather than somebody leaving. |
| **Pay, then cancel** | Access runs to the end of the period they paid for. Cancelling is not a refund. |
| **Refund the last order** | Revoked immediately, with **no** grace window — otherwise a refund would be a way to keep both the premium and the money. |

Once subscribed, the premium page keeps a **Demo payment controls** panel so the later outcomes
stay reachable; a real provider never shows it.

None of this is a shortcut. Each button signs a payload and posts it at the same webhook route a
real provider posts to, so the demo exercises signature verification, the idempotency key, the
parse, the subscription upsert and the entitlement projection. To see that it is real entitlement
rather than a page saying so, open any board's **notification settings** afterwards: the
per-status checkboxes are premium-only and read the projection the webhook wrote.

Everything the fake writes is stamped `provider = 'fake'`, so it stays distinguishable from real
money if this database ever outlives the demo.
