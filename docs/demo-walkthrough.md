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

### 0. The board moves one column at a time

Columns are tabbed rather than side by side: four at once truncated every one of them at laptop
width. Use the arrows either side, the strip along the top, the arrow keys, or — on a trackpad or a
phone — **swipe**. Dragging right reveals the column to its left, because the content follows the
gesture.

A mouse is left out of that deliberately: it already has the arrows and the wheel, and a
click-drag on a board is how a card gets moved.

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

As **Ada**, move **Perfect Blue** and **My Neighbor Totoro** to Now Playing, one after the other.
Bea gets **one** bell item — "…and 1 other change" — not two. A creator tidying a board is one
act, not eight notifications in everybody's evening.

Both are Cal's suggestions on purpose. Folding is per reader and per kind of news, and a reader
hears about their *own* suggestion moving as a different kind — so moving Bea's own **Princess
Mononoke** produces a separate item beside the folded one rather than joining it. That is correct,
and it is why this step names the entries instead of saying "move some".

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

Spirited Away carries one of each already, so the second half is true before you do anything: Bea
sees 🍿 1 greyed out and titled "part of the premium palette", beside 👍 1 she can use. A board with
no reactions at all shows her six emotes and no evidence the other six exist.

Reading is never gated. Otherwise a count would vanish the day somebody stopped paying, which is a
lie about the data rather than a locked feature.

### 10b. What the board tells the world

As **Ada**, open **Settings** from the board. Boards are **subscribers-only by default**, and each
option says what it *exposes* rather than what it is called — because "public" sounds harmless, and
what it actually means is a readable list of what a creator is currently watching.

The middle option says plainly that a Patreon account is free to create. Against an automated
reader it is no different from open to everyone, which is exactly the mistake it invites.

Below it, **what it takes to take part** — who may suggest something, and who may upvote. These
are deliberately separate from reading: letting somebody see the board and letting them add to it
are different decisions, and a creator who wants an open board with a gated suggestion box should
not have to choose between them. Set **Who may suggest something** to a tier as Ada, then look at
the board as **Bea** ($5) and as **Cal** ($15) — the suggestion box appears for one and not the
other, and the server refuses either way.

The unset option reads **"Any supporter, at any tier"** rather than "anyone", because that is what
it does: it drops the requirement to any active patron, it does not remove it. A settings page that
overstates what it just turned off is worse than one that never offered the setting.

A creator can hand all of this to a moderator with **Change board settings** on the moderators
page. Running the queue and deciding who may read the board are separate powers, so it is granted
deliberately or not at all.

### 11. Staff, invites and reports

As **Ada**, invite a moderator from **/c/ada-watches-things/staff**. Accept it as someone else, and
then remove them. Permissions are per-board and per-capability — `MOVE_ENTRIES`, `EDIT_ENTRIES`,
`HANDLE_REPORTS`, `WRITE_NOTES`, `MANAGE_THEMES` — not one "moderator" switch.

**/c/ada-watches-things/tickets** is where reports land.

### 11b. Making a board at all

Until recently there was no way to do this from the app: the endpoint existed and no page called
it, so every board here was created by SQL. Sign in as **Ada** and the landing page offers
**Create a board for it**.

Her campaign appears as *already a board* — a link to it rather than an offer to make it again,
because pressing claim on a campaign you already claimed answers 409 and sending you to the board
is the answer you wanted. To see the other side, sign in as **Bea**, who runs no campaign: the page
says Patreon lists none for the account rather than showing an empty box.

A new board starts visible to **only your supporters**, and the page says so before you make one —
a board the whole internet can read is a list of what you are watching.

### 11b2. A vote is worth what the tier is worth

On **Settings**, above the blocklist: **what a vote from each tier counts for**. Sidekick is 1 and
Producer is 3, so the board is not ranked by how many people upvoted — it is ranked by what those
upvotes are worth here.

You can see it on the board without changing anything. *Spirited Away* has **2** upvotes and a
weighted score of **4**, because one of those votes is Cal's and Cal is a Producer. *Perfect Blue*
has 1 and 1, because Bea is a Sidekick. **Top rated** sorts on the second number.

*Princess Mononoke* is the interesting one: it also has 2 upvotes, one of them Cal's, and its
weighted score is **2**. Cal upvoted it before he upgraded, and a vote stores the tier it was cast
at rather than the tier its owner holds today. That is not a bug in the weighting — it is the
whole reason §11b3 below exists.

Set Producer back to 1 and *Spirited Away* collapses from 4 to 2: every tier at 1 is a plain
popularity sort, which is the one thing this mechanic exists not to be. *Princess Mononoke* does
not move, because nothing in it was ever counted above 1. The change reaches votes already cast
— a vote stores which tier it came from, not a copied number — so the board re-ranks immediately
rather than waiting for somebody to vote again.

Zero is allowed, and means votes from that tier are counted but carry no weight in the order.

### 11b3. A vote already cast can be brought up to date

Sign in as **Cal** and open **Your votes**. One of them — *Princess Mononoke* — is marked
**worth 1, below your tier**: he upvoted it while he was a Sidekick and has since become a
Producer. **Bring them up to date** lifts it to what his tier is worth now, and the board re-ranks.

Only upward. A vote already worth more than the reader's current tier is left alone: somebody who
downgrades does not have their past support quietly taken back.

### 11c. Words a board will not accept

As **Ada**, open **Settings**. Below the tier gates is the blocklist, and the demo already has two
words on it: **ganondorf** is refused outright, **spoiler** is sent for review. They have been
enforcing on every suggestion since this demo was built, and until recently no screen showed them.

Try suggesting *"a bootleg recording"* after adding **bootleg**. The refusal names no word, on
purpose — §9 wants nothing that lets somebody find the boundary by submitting until they hit it.
Worth knowing that a blocked suggestion is also scored as abuse: enough of them and the refusal
becomes a timeout.

### 11d. Renaming and merging themes

**Themes**, from the board, needs `MANAGE_THEMES`. Rename one, or merge two into one — themes are
suggested automatically, so a board ends up with "Anime" and "anime" and neither is wrong. The
merge says how many entries it will move before it moves them, because it cannot be undone here.

### 11e. The Patreon webhook

Also on **Settings**, owner-only. It shows the URL to give Patreon and whether a secret is
registered — never the secret, since any prefix of one is a head start.

Without a secret the signature check rejects **every** delivery, and nothing looks broken when that
happens: memberships still arrive, just at the next sync. That is why the page says it plainly.

### 12. The rest

- **/notifications** — everything, with filters and severity ordering.
- **/c/:slug/my-votes** — what you have upvoted.
- **/c/:slug/e/:id** — an entry has its own page and a shareable URL.
- **/c/:slug/notifications** — per-board news settings. **Premium-gated**, and the honest place to
  check that a purchase actually landed.
- **Themes** — narrow the board to one theme; rename and merge them at **/c/:slug/themes**.
- **The ⋯ menu**, top right — the app's own links. **Support the developers** lives there rather
  than in a footer under every page, and it does not offer to take you to the page you are on.
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
| **Refund the last order in full** | Revoked immediately, with **no** grace window — otherwise a refund would be a way to keep both the premium and the money. |
| **Refund $1 of it** | Nothing changes. They are still subscribed and still being charged, so taking premium away would punish somebody who has done nothing wrong. |

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
