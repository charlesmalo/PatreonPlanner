# Playing with it

A full end-to-end demo of everything built so far — two boards, five people, real OAuth, real
moderation, and premium you can actually buy.

```bash
docker compose -p patreonplanner-demo -f docker-compose.demo.yml up -d --build --wait
```

| | |
| --- | --- |
| **App** | http://localhost:8081 |
| **Choose who to be** | http://localhost:4001/\_\_be |

If `docker compose` is not wired as a plugin on your machine, the standalone `docker-compose`
binary takes the same arguments.

Signing in goes through the **real OAuth flow** against a stub that stands in for Patreon, rather
than a shortcut around it — so consent, token exchange, membership sync and session cookies all
run exactly as they do in production.

The background tick runs every **15 seconds** here rather than the deployed fifteen minutes, so
queued work resolves while you are watching it.

## Who you can be

Pick at http://localhost:4001/\_\_be, then press sign in.

| | |
| --- | --- |
| **Ada** | Owns *Ada Watches Things*. Moves entries, decides links, sees the review queue. |
| **Mo** | Moderates Ada's board **and** owns *Mo Reads Things* — the two roles are separate, and the difference is visible. |
| **Bea** | Patron of both, $5. Narrowed her news to **Anime**. |
| **Cal** | Patron of both, $15, and the only one starting with premium. Narrowed to **Documentary**, but follows one Anime entry anyway. |
| **Dee** | **Lapsed.** Can read, cannot submit. The split is invisible if everyone can do everything. |

The five exist so permission is something you can *see*. Most of what is interesting below is a
difference between two of them looking at the same page.

---

## The tour

Roughly in order. Each one is a thing that was built deliberately, with the reasoning behind it.

### 1. The board, and who may do what

Open **Ada Watches Things** as nobody at all — signed out. It reads. Now sign in as **Dee**, who
has lapsed: still reads, but the suggestion box is gone. As **Bea**, it is there.

Entries move `PENDING → ACCEPTED → ACTIVE → COMPLETED`, and the board is columns of exactly that.
*Ghost in the Shell* is `REJECTED` and appears for nobody but staff.

### 2. Suggesting, and not suggesting the same thing twice

As Bea, type **Spirited Away** into the suggestion box — it is already on the board, so you are
offered an **upvote** rather than a duplicate. Now type it badly: **"sprited away"**. Trigram
search finds it anyway. This is the single most load-bearing piece of the submit flow; a board
fills up with near-duplicates without it.

### 3. A link waits for a human

As Bea, open **Princess Mononoke**. One link shows. Sign in as **Ada** — a second appears as a
**candidate**, with Publish and Discard beside it.

A patron's link is a claim, not the creator's endorsement, until somebody says so.

### 4. Moderation, and what stays private

As **Ada**, open the **review queue**. Move something. Redact a description and watch the board
show the redaction rather than quietly losing the text.

Write two notes on an entry — one **TIMELINE**, one **COMMENTARY**. Only the timeline note reaches
the board. The kind is the only thing keeping them apart, which is why the board test asserts
against the whole page rather than a selector.

### 5. Who hears about a move

As **Ada**, move **Perfect Blue** to Now Playing. **Bea's** bell rings: it is Anime, and Anime is
what she asked for.

Now move **Paprika**, which has no catalogue title. Silence — themes hang off a catalogue title,
so a hand-typed entry has none. That is the real cost of reusing the creator's vocabulary instead
of inventing a private one, and the settings page says so rather than hiding it.

### 6. A follow beats the narrowing

Cal narrowed to **Documentary**, so nothing on Ada's board should reach him. Move **Princess
Mononoke** — it reaches him anyway, because he follows that one entry.

Statuses answer *what counts as news*. A follow answers *about what*, and it is the most specific
answer there is.

### 7. Tidying is one piece of news

Move three entries to Now Playing in a row. Bea gets **one** bell item saying "and 2 other
changes", not three. A creator tidying a board is one act, not eight notifications in everybody's
evening.

### 8. Carrying a list across boards

As **Cal**, go to **/carry-over**. Send **My Neighbor Totoro** to *Mo Reads Things*. Within about
fifteen seconds the dashboard says **Suggested**, and it is on Mo's board.

Now send **Piranesi**. That one comes back **Already on that board**, and offers you an upvote
rather than casting one on your behalf.

### 9. Buying premium

See **[Buying premium](#buying-premium-1)** below — it is the longest section, because the whole
billing path runs for real here.

### 10. Premium is a gate, not a wall

As **Cal**, react to anything with 🍿. As **Bea**, try the same emote: the control is disabled and
says why. Then look at an emote somebody has already used — it still shows, **with its count**,
for everyone.

Reading is never gated. Otherwise a count would vanish the day somebody stopped paying, which is a
lie about the data rather than a locked feature.

### 11. Staff, invites and reports

As **Ada**, invite a moderator from **/c/ada-watches-things/staff**. Accept it as someone else, and
then remove them. Permissions are per-board and per-capability — `MOVE_ENTRIES`, `EDIT_ENTRIES`,
`HANDLE_REPORTS`, `WRITE_NOTES`, `MANAGE_THEMES` — not one "moderator" switch.

**/c/ada-watches-things/tickets** is where reports land.

### 12. The rest

- **/notifications** — everything, with filters and severity ordering.
- **/c/:slug/my-votes** — what you have upvoted.
- **/c/:slug/e/:id** — an entry has its own page and a shareable URL.
- **/c/:slug/notifications** — per-board news settings. **Premium-gated**, and the honest place to
  check that a purchase actually landed.
- **Themes** — narrow the board to one theme.
- **Franchises and watch orders** — a film nests under its franchise; a watch order can be
  composed, reordered and submitted as one thing.

---

## Buying premium

Go to **/premium** and press **Subscribe**. That lands on a deliberately ugly stand-in for the
payment provider's own page, with a button for each thing a subscription can do.

| | |
| --- | --- |
| **Pay $5.00** | Entitled immediately, with the payment listed under *Payments*. |
| **Card declined** | Nothing recorded at all — a declined card never reaches the merchant's webhook, so there is no subscription and no receipt. |
| **Pay, then let the renewal fail** | `PAST_DUE`. Access continues through a five-day grace window, because a failed card is usually a card that needs updating rather than somebody leaving. |
| **Pay, then cancel** | Access runs to the end of the period they paid for. Cancelling is not a refund. |
| **Refund the last order** | Revoked immediately, with **no** grace window — otherwise a refund would be a way to keep both the premium and the money. |

Once subscribed, the page keeps a **Demo payment controls** panel so the later outcomes stay
reachable. A real provider never shows it.

**Try it as Bea or Dee**, who start without premium, so you see the before and after. Cal already
has a subscription; buying as him demonstrates *resubscribing*, which is worth seeing too — it was
silently broken until the demo exposed it.

### None of this is a shortcut

Each button signs a payload and posts it at the **same webhook route** a real provider posts to.
Signature verification, the idempotency key, the parse, the subscription upsert and the entitlement
projection all execute. Granting entitlement directly would have demonstrated the outcome while
skipping every line that has ever held a bug.

To check it is real entitlement rather than a page saying so, open any board's **notification
settings** afterwards: the per-status checkboxes are premium-only and read the projection the
webhook wrote — a different source than the panel you just looked at.

Everything the fake writes is stamped `provider = 'fake'`, so it stays distinguishable from real
money if this database ever outlives the demo.

---

## What the demo cannot show

- **A real Lemon Squeezy payload.** The fake provider proves this codebase's plumbing end to end;
  it says nothing about whether Lemon Squeezy's actual payload matches what the adapter expects.
  Billing fails **closed but silent**, so a mismatch means a subscriber pays and gets nothing.
  `docs/billing-sandbox-runbook.md` is the only thing that settles it.
- **Email actually arriving.** No provider key, so the digest job logs what it would have sent
  rather than sending it. `docs/email-setup.md`.
- **Anything from TMDB.** The catalogue is stubbed; searching finds the stub's fixtures.
- **The donation page.** Built and switched off — it needs `VITE_DONATION_URL`.

## Starting over

```bash
# Keep the data — a playtester who restarts finds their board where they left it
docker compose -p patreonplanner-demo -f docker-compose.demo.yml restart

# Wipe it and reseed
docker compose -p patreonplanner-demo -f docker-compose.demo.yml down -v
docker compose -p patreonplanner-demo -f docker-compose.demo.yml up -d --build --wait
```

The seed is idempotent, so running it twice changes nothing.

## If something looks wrong

```bash
docker compose -p patreonplanner-demo -f docker-compose.demo.yml logs api --tail 100
```

The API logs a warning on every boot that runs the fake payment provider. If you do **not** see it,
the stack is not the one this page describes.
