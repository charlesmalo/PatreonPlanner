# Phase 2 — Board Experience Design

**Status:** every section below is built and merged, except where an amendment says otherwise.
Decisions marked **OPEN** need an answer before the plan that touches them.

**Amendment A (2026-08-26)** is appended at the end: it resolves what premium contains, and adds
two premium features that were not in the original scope. It is appended rather than renumbered
because plans, commits and code comments reference these sections by number.

**What this covers:** the kanban board, weighted voting, grouping related entries, where watch
links come from, disputes and contact tickets, granular moderator permissions, the moderator view
switch, the donation link, reactions, and what premium may and may not be.

**What it does not change:** the access model (`VIEW | UPVOTE | SUBMIT | MODERATE | ADMINISTER`
resolved per creator), multi-tenancy, or the moderation pipeline. Those hold as built.

---

## 1. The board becomes a kanban

Design §7 already specifies a kanban dashboard for creators and mods. This makes it the primary
view for **everyone**, read-only for those without write capabilities.

Columns are the lifecycle statuses, which already exist: **Suggestions** (`PENDING`) →
**Accepted** → **Now Playing** (`ACTIVE`) → **Completed**. `REJECTED` and `DELETED` stay off the
board and remain reachable from the review queue.

- **Cards are collapsible summaries.** Each opens into its own page (`/c/:slug/e/:id`) with the
  full description, notes, links, availability and history. A shareable URL per entry is worth
  having on its own.
- **Columns collapse left or right**, so a creator working through Accepted can push the rest out
  of the way. Collapsed state is per-reader and local; it is not board configuration.
- **Moving a card:** left/right arrows on every card, plus drag-and-drop. Arrows first and
  drag-and-drop second — arrows work on touch, work with a keyboard, and are announceable to a
  screen reader, which drag-and-drop is not without significant extra work.
- **Narrow screens get one column at a time** with a column switcher. Horizontal kanban on a phone
  is unusable, and a Patreon audience is heavily mobile. This is the same data, not a second
  implementation: the existing vertical layout becomes the narrow-screen form.

### Ordering — **decided**

**Upvote-driven is canonical.** The board is a demand signal; the default order should encourage
voting and reflect it. Manual order is available as an explicit per-column sort mode, and card
placement is only preserved while that mode is active — in any other sort, an arrow or a drag
changes status, not position.

This needs a persisted rank per entry (fractional/lexo-style, so an insert between two cards does
not renumber the column). Sort modes per column: **upvote weight**, **newest**, **manual**, with
creator-favourited entries sub-sorted to the top without a separate filter.

---

## 2. Weighted voting

A creator assigns a **weight** to each of their Patreon tiers (e.g. 20/15/10/5/2/1). An upvote
counts for the weight of the tier the voter held.

### Storage — **decided**

A vote stores the **tier it was cast at**, never a copied number.

```
Upvote        (recommendationId, userId, tierId)
UpvoteTally   (recommendationId, tierId, count)   -- denormalised counts, not products
```

Displayed weight is `Σ count × tier.weight`, computed on read by joining the tiers. A board page
is roughly twenty entries across a handful of tiers, so the sum is trivial.

**Why counts rather than a cached product:** if the creator rebalances tier weights, nothing
derived is stored, so **no backfill is needed and no cache can disagree with the tiers**. The
backfill is the expensive, failure-prone part of the alternative. Materialise the product only if
measurement says the join is too slow.

### When a patron changes tier — **decided**

- Existing votes keep the tier they were cast at. New votes use the new tier.
- The voter gets a page listing everything they have upvoted, with an action to **update** those
  votes to their current tier.
- That update **only ratchets upward**: a past vote moves to the current tier only where the
  current tier's weight is greater. It never moves down.

The intent is that paying more, even once, is not wasted — which is a deliberate incentive rather
than a neutral rule.

**Two consequences to accept knowingly:**

1. A **creator rebalance can still lower** an existing vote's value. The ratchet protects against
   the voter's own downgrade, not against the creator changing what a tier is worth. This is
   correct — the creator owns the weights — but it is the one path where a vote falls without the
   voter acting.
2. The ratchet is permanent, so a board's totals drift over time toward each voter's *historical
   peak* generosity rather than current support. That is the intended incentive, and it does make
   the demand signal less accurate as a board ages. **Therefore the ratchet is a creator-level
   toggle**, so a creator who wants a live signal can turn it off.

### Consequences elsewhere

- **Tiers are archived, never deleted.** Once votes reference a tier, deleting it destroys the
  meaning of historical votes. The codebase already refuses to delete tiers referenced by policy
  (`onDelete: Restrict`, so a deletion cannot silently widen access); votes extend that.
- **Show headcount alongside weight.** "210 points" hides whether that is forty people or three.
  Both numbers are honest and they answer different questions.
- **Free/public is not weight zero — it is the `UPVOTE` capability denied.** The access resolver
  already handles this. A zero-weight vote would otherwise sit in the tallies contributing nothing
  while still counting as a person.

---

## 3. Grouping related entries

Broader than de-duplication, which is the narrow case. Three things that should live on one card:

- **The same work under different titles** — "Your Name" / "君の名は。"
- **Seasons and parts** — Re:Zero season 3 when 1 and 2 are already on the board.
- **The same work reachable on different platforms or regions.**

**Grouping preserves; merging destroys.** Seasons must remain individually visible, so this is a
group with a canonical head and ordered members — closer to the parent/child nesting that already
exists for franchises than to the theme merge built in Plan 19.

**Reuse the existing parent/child relation** rather than introducing a fourth grouping concept
alongside de-dupe, nesting and themes. A group is a head entry with ordered children; the board
shows the head with its children nested and collapsible.

Rules:

- Only staff with the right permission may group or ungroup.
- **Grouping must de-duplicate voters.** Someone who upvoted two entries that are then grouped
  counts once, at their highest tier. Getting this wrong inflates the head's weight silently — the
  same trap Plan 19's theme merge hit with title assignments.
- Ungrouping restores children as independent entries; it does not delete anything.

### Weight — **decided: the sum across children**

A group's weight is the sum over its members, **de-duplicated by voter**: someone who upvoted two
entries that are then grouped counts once, at their highest tier across the group.

Two consequences follow, and both are load-bearing:

1. **The head's stored `weightedScore` becomes that sum.** The board ranks on a column and pages
   by keyset, so a displayed weight computed separately from the ordering would put groups in a
   position their number does not explain. One number, used for both.
2. **Grouping and ungrouping recompute it**, in the same transaction as the relation change —
   the same rule the tier rebalance follows.

---

## 4. Where watch links come from

Two sources that must not be conflated:

**Provider availability (data).** TMDB's watch-providers endpoint, already integrated in Plan 10,
gives "on Crunchyroll in CA, Netflix in AU" per region, refreshed on a schedule. This is
authoritative and is where "you'll need a VPN for this one" comes from — derived from data rather
than from patrons pasting regional links.

**Suggested links (claims).** URLs submitted by people. These are *candidates*, not published
links.

> **A URL from a non-staff submitter is a candidate visible to staff, never a live link on the
> board.** Otherwise any patron can attach a URL to any existing card by submitting a duplicate —
> link injection on someone else's board, carrying the creator's implicit endorsement. The
> moderation pipeline screens for profanity, not for phishing.

Handling:

- A submission matching an existing entry **contributes its link as a candidate** rather than
  being rejected as a duplicate. The submitter is told the entry exists and invited to upvote.
- Staff **promote** a candidate to a published link, or discard it.
- Staff may **lock a preferred link** for an entry. Once locked, later submissions stop queueing
  candidates for it.
- **Regional variants canonicalise** for the known platforms: Netflix uses the same numeric id
  across TLDs, YouTube ids are global, Crunchyroll slugs are consistent. Unknown domains are
  treated as distinct rather than guessed at.

### What is not achievable

Searching the platforms directly is **not available for free, and mostly not available at all**:
Netflix has had no public API since 2014; Crunchyroll has no public search API; Amazon's PA-API
requires affiliate approval and ongoing sales; IMDb has no free API and its datasets are licensed
non-commercial. YouTube's Data API is free but capped at 10,000 units/day with search costing 100,
i.e. **~100 searches per day across all users combined**.

Scraping them is rejected: it violates their terms, breaks without notice, and is the one part of
this product that could attract a legal letter.

**So: one search against TMDB.** Once a title resolves we already know its platforms and regions.
TMDB returns a JustWatch deep link rather than a platform-native URL, so autofill lands on a
chooser — worth saying in the UI rather than implying otherwise.

---

## 5. Search and submission

**One input, not two.** The current form has a catalogue search *and* a separate free-text title
field, and at submit time read only the second — a playtester typed the title into the search box
and the form silently refused. Partially fixed already; the real fix is that the search box **is**
the title field.

- Debounce **500ms** after typing stops, so a title costs one request rather than one per
  keystroke.
- An empty result says so plainly and offers **"add it anyway"**, rather than leaving the reader to
  discover a second field.
- Picking a catalogue result binds the canonical title and, where available, prefills a link.

---

## 6. Disputes and contact tickets

These are one mechanism, not two: **a message from a reader, routed to staff, with a resolution
and an optional reply.** The subject is either a card (a dispute — "this is season 3, not a
duplicate") or nothing (general contact).

- Staff work them from one inbox, alongside the review queue.
- Resolutions: **confirm** (the reader is right — then place, group or create the card),
  **deny**, **link to an existing entry**, or **close**.
- Replies: canned text per resolution, editable, plus a deliberately uninformative
  "handled internally" for cases where the honest answer is one you do not want to explain.
- **Signed-in by default.** A public contact form on a public board is the highest-value spam
  target in the app; the creator may opt into accepting messages from signed-out readers.
- Creators may filter general contact out of their own notifications and leave it to mods.

An **About** section is separate: creator-authored text on the profile, with no inbox behind it,
so it cannot become an unattended support channel.

---

## 7. Granular moderator permissions

Today: `StaffRole = OWNER | MOD`, with `MODERATE` covering all mod actions and `ADMINISTER`
reserved for the owner. This adds a permission set per staff member, granted by the owner.

Candidate permissions: move cards · edit/redact · resolve flags · handle tickets · group/ungroup ·
manage links · manage themes · manage the blocklist.

**Fail closed.** A new permission is denied to everyone until explicitly granted, and the resolver
stays a pure function so it remains testable in isolation. This is the area with the worst history
in this codebase — review previously caught a mod being able to make a paid board public and forge
webhook secrets — so defaults matter more here than anywhere else.

Anything a mod can do, an owner can do. No creator or mod can affect another creator's board;
this already holds and is the most heavily tested property in the system.

A **permissions page** for owners: grant, revoke, and see what each mod currently holds.

---

## 8. Viewing as moderator

A mode switch in the header, with the banner, accent colour and logo badge changing so the current
mode is obvious at a glance.

- **No re-authentication on every switch.** It trains people to click through auth prompts and
  makes the feature hated.
- **Acknowledge on switch after inactivity.** If the session has been idle beyond a threshold,
  switching into moderator view asks for confirmation, with **"don't remind me for 24 hours"** to
  keep the friction low. This stops a long-abandoned tab being used to make changes nobody meant
  to make.
- **The mode is presentation only.** The server keeps enforcing real capabilities regardless of
  what the tab believes. If the mode became an authorization input, a client-side toggle would be
  a security boundary, which it must never be.

**Tier and role badges:** a curated palette with guaranteed contrast, not colours generated from a
tier index — generated values routinely fail contrast, and colour alone excludes colourblind
readers. Always pair the colour with a text label. The logo stays put; the badge sits beside it,
so the page keeps one fixed landmark.

---

## 9. Supporting the developers

A single app-level page reachable from the footer. **Not on creator boards** — a donation ask on a
creator's page competes with that creator's own Patreon ask, in front of an audience that came for
them, and creators would reasonably read it as monetising their audience.

- Preset amounts **2 / 5 / 10 / custom**, with **5 preselected**, custom validated as a positive
  number, currency stated explicitly.
- **Link out; do not integrate payments.** A PayPal.me / Ko-fi / Buy Me a Coffee link accepts the
  amount as a URL parameter, keeps every payment credential outside this system, and avoids
  webhook confirmation, refunds, chargebacks and PCI scope for a feature whose purpose is covering
  a domain fee.
- **Disclaimer**, as uBlock and similar carry: a voluntary gift supporting development, may not be
  tax-deductible, and following local rules is the giver's responsibility.

### Premium — **decided in principle**

**Premium is cosmetic and quality-of-life only. No feature is withheld from free users**, and no
limit set by a creator is ever overridden by something a user bought from us.

The governing precedent is Discord Nitro, which sells cosmetics and better emoji and pointedly
does **not** let a subscriber post faster in a server whose admin set a rate limit. The same line
holds here: the abuse limiter stays a security control, and the per-board submission quota belongs
to the **creator** — it is their policy about how much one patron may put on their board, and they
absorb the moderation cost of the result. Selling relief from it would put our revenue in
proportion to their workload.

If quotas should be more generous for some people, the two honest routes are app-level actions
that land on nobody's board (catalogue searches), or letting the **creator** grant a higher quota
to whoever they choose. Not the app selling it over their head.

**Premium is a property of the `User`, not of a (user, creator) pair.** It never enters
`can(capability, viewer, policy)`, so it cannot become an authorization input — which a per-board
perk eventually would.

**The token presentation is built regardless of payment.** "3 suggestions left, next unlocks at
14:20" is far better than an opaque 429 and reads as a budget rather than a punishment.

**Resolved in Amendment A.** Premium contains usage headroom on limits that are ours, quality-of-
life conveniences, and cosmetics — and two features, carrying a list across boards and following
what moves, that were not in the original scope.

### Creator-gifted cosmetics

A creator may **opt in** to gifting the expanded palette to a tier of their patrons, or stay
entirely disconnected from the app's paywall and let their community buy premium individually.
Both are supported; neither is required.

**Gifted cosmetics are free — no revenue share.** A percentage of a Patreon pledge is not
collectable in any case: Patreon has no revenue-share or split-payment API for third parties, so
the money never passes through us and there is nothing to take a cut of. The buildable version
would be a separate bill to the creator, calculated from tier price × headcount — usage-based
billing, with metering, proration as patrons come and go, count disputes, invoicing and dunning.

It is not worth it, because **the palette has zero marginal cost**: it is a curated set we ship,
deliberately with no uploads, no storage and no CDN bill, so serving it to ten thousand people
costs what serving it to ten costs. Metered billing to recover cents against a cost that does not
scale is a great deal of machinery for very little. It also has a nasty failure mode — a creator's
card fails and the community loses cosmetics they did nothing to lose.

Two further constraints if this is ever revisited: metering on tier prices and headcount means
holding business-sensitive campaign data as a billing input, and Patreon's platform terms govern
what third parties may do with campaign data and with monetisation layered on pledges. Read them
first, not after.

**If creator-side revenue ever matters, make it a flat plan** — predictable, no proration, no
headcount disputes, card on file so the processor's dunning handles failure, and no accounts
receivable. Invoicing on trust is unsecured credit: aging balances and chasing, for amounts
measured in single dollars, where collecting costs more than the sum owed. Discretionary waivers
are fine for a handful of relationships and unbounded personal work at any real number of them.

> **Non-payment must never suspend the community's cosmetics.** Patrons paid their pledge in good
> faith and had no part in the creator's bill; taking their reactions away puts the support burden
> on the creator and the reputational damage on us, while the person who owes money is the only
> one unaffected. What lapses is the **creator's own** features — branding, analytics, board
> customisation.

**Build none of this until someone asks.** There are no creators on the platform. When the third
one wants it: a payment link sent by hand and a boolean on their row — an afternoon, not a
subsystem. Automate only once doing it manually becomes annoying, by which point the real usage
pattern is known rather than guessed.

---

## 10. Reactions

Separate from upvotes, and worth building on their own merits rather than as a premium hook.

Today enthusiasm and demand are the same button: people upvote to say "yes!" when they mean
"I would watch this", which pollutes the very signal the board exists to produce. Reactions give
hype somewhere to go that does not touch ranking.

- **Reactions never affect ordering.** One per person per emote, unweighted, and not an input to
  any sort. The moment they influence rank they become a second voting system with none of the
  tier weighting that makes the first one meaningful.
- **A curated set we ship — never uploaded images.** User- or creator-uploaded emotes mean image
  hosting, storage cost and a content-moderation surface considerably worse than text, and they
  break the free-only constraint the first time a CDN bill arrives. Premium unlocks *more of the
  set we already ship*, which costs nothing to serve and cannot be abused.
- **Creator toggle.** Some boards will not want emoji on them at all.
- **Their own rate limit**, for the same reason everything else has one: reacting to four hundred
  entries in a minute is a thing people do.
- **Generic attachment from the start** — entries and notes now, comments when discussion threads
  arrive (design §12 puts those in Phase 2) — so comments do not need a second implementation.

Stored like upvotes are: a row per (subject, user, emote), aggregated into counts for display.
Unlike upvotes there is no tier reference, because reactions carry no weight.

---

## 11. Sequencing

Cheapest and highest-value first; each produces something usable on its own.

1. Entry detail page and shareable URL
2. Kanban layout with arrow moves (no drag-and-drop yet) and column collapse
3. Per-column sorting, including creator-favourited
4. Weighted voting: tier weights, tallies, the ratchet, the my-votes page
5. Granular permissions and the permissions page
6. View-as mode with the inactivity acknowledgement
7. Disputes and tickets inbox — **shipped**
8. Grouping and the link/candidate model
9. Donation page
10. Reactions
11. Drag-and-drop, as an enhancement over arrows that already work

## Open questions

- ~~Premium: what it contains beyond the reaction palette~~ — resolved in Amendment A
- **Does email get a paid provider?** Amendment A.4 needs this answered before anything is built
  against it — it is the first collision with the free-tier-only constraint
- Where notification filter rules are evaluated, and whether interest tagging reuses a creator's
  themes (Amendment A.4)
- Which permissions belong in the granular set, and which stay bundled under `MODERATE`? (§7)

---

# Amendment A — What premium contains

**Date:** 2026-08-26. **Status:** decided in principle; A.3 and A.4 need plans before they are
built. Appended rather than renumbered because §1–§11 are referenced by number from plans, commit
messages and code comments.

## A.1 The rule, restated so it can actually be applied

§9 says premium is *"cosmetic and quality-of-life only"* and that *"no feature is withheld from
free users."* Read strictly those two clauses contradict each other: any quality-of-life feature
only premium users get **is** a withheld feature, so the strict reading leaves premium containing
nothing but cosmetics.

**The operative rule is therefore narrower and testable:**

> Nothing the board's purpose depends on is ever withheld. Reading, voting, submitting, searching,
> moderating and being notified are free forever, on every board, for everyone. Premium buys
> convenience *around* those, and headroom on limits that belong to us rather than to a creator.

The three constraints from §9 are unchanged and bind everything below:

1. **A creator's limit is never overridden by something a user bought from us.** The per-board
   submission quota is the creator's policy about how much one patron may put on their board.
2. **Premium never enters `can(capability, viewer, policy)`.** It is a property of the `User`, not
   of a `(user, creator)` pair, so it cannot become an authorization input.
3. **Nothing may require a paid dependency.** See A.4, which is the first place this bites.

Per-*pair* **preferences** are fine and do not violate (2): a preference is not an authorization.

## A.2 What premium contains — **decided**

**Usage headroom.** Limits that are ours to raise, never a creator's:

- **A larger catalogue search allowance.** `SEARCH_LIMIT` is 30 burst / 60 per minute. Searching
  lands on nobody's board and results are already cached, so a heavier allowance costs us close to
  nothing. §9 names this route explicitly.
- **A larger cross-board submission cap.** `SUBMIT_LIMIT_PER_HOUR_GLOBAL` is 5;
  `SUBMIT_LIMIT_PER_HOUR` is 1 **per creator**. Raising only the global figure lets an active
  patron take part on more boards per hour while **no individual creator receives one extra
  submission**, because their own limit still binds. This is the only place "more usage" is
  honestly available, and it is what makes A.3 possible at all.
- **Never the coarse limiter**, which is a security control, and **never the per-board quota**.

**Quality of life.** Convenience around capabilities everyone already has:

- **Settings that follow you.** Column collapse, per-column sort and view mode live in
  `localStorage` (`pp.board.${slug}.*`), so a reader following six creators re-derives all of it on
  every device. Premium syncs them server-side. Free users keep every feature — per device.
- **Cross-board interest alerts** and **granular notification control** — A.4.
- **Carrying a list across boards** — A.3.

**Cosmetics.** As §9 and §10 already establish: the expanded reaction palette, colour schemes and
board themes for one's own view, and profile flair.

Flair appears on somebody else's board, so it takes the same creator toggle reactions already
have. Some boards will not want our badges on them, and finding that out after the fact is worse
than offering the switch.

### What premium never contains — **decided**

These are ruled out permanently, not deferred:

- **A limit invented in order to sell its removal.** There is no cap on favourites or followed
  boards today. Adding one so premium can lift it is the exact move this section exists to
  prevent, and it is far more visible to users than it feels when shipping it.
- **Data export.** Cheap to serve, an expectation rather than a luxury, and paywalling it earns
  little relative to how it reads.
- **Shorter notification retention for free users.** Technically not a withheld feature, but it
  takes away rather than adds, and anyone who had the longer window during beta experiences it as
  a downgrade.
- **Relief from moderation-visible limits.** Anything that puts our revenue in proportion to a
  creator's workload, by any mechanism, including indirect ones. A.3 is checked against this.

## A.3 Carrying a list across boards — **decided in principle**

A patron who follows several creators wants the same handful of titles in front of all of them.
Doing it by hand means repeating every submission per board and tracking what already landed
where. This is a legitimate premium feature on the strongest available test: **it cannot be done
by hand at any useful scale.** Compute cost is a much weaker justification and should not be the
one used.

**The user builds a list** — from titles they have already submitted anywhere, or assembled
directly — and broadcasts it to the creators they support. Delivery is a **background queue**, not
a burst.

### The queue feeds the existing submit endpoint — **decided**

Carry-over does **not** get its own submission path. Every item is delivered through the endpoint
patrons already use, which gets four things right that a parallel path would have to re-derive:

- **Order of operations.** Moderation, then rate limit, then de-duplication. §5 fixed this order
  deliberately: de-duping first would let a blocked resubmission confirm what exists on a board the
  sender cannot read.
- **Eligibility at delivery time.** A pledge can lapse between queuing forty titles and delivering
  the fortieth. Capabilities resolve per request, so the queue cannot outlive the entitlement that
  authorised it.
- **De-duplication and its disclosure properties**, already correct and already tested.
- **Rate limiting per board.** One title to ten boards is one submission per board and exceeds
  nobody's quota — which is what keeps this inside constraint (1) of A.1.

### Rejection must block carry-over, though it does not block a person — **decided**

De-duplication filters on `status: { notIn: HIDDEN_STATUSES }`, and `HIDDEN_STATUSES` is
`['DELETED', 'REJECTED']`. **A rejected entry therefore does not prevent a fresh submission of the
same title.**

That is correct for a human: a creator may have rejected something for a reason since resolved,
and a person choosing to resubmit is exercising judgement. It is wrong for an automated one, which
would re-propose refused content on a schedule and has no judgement to exercise.

**Carry-over needs a rejection check that manual submission deliberately lacks.** Small to build,
easy to omit, and genuinely hostile if omitted.

### Auto-submit is automatic; auto-vote is confirmed — **decided**

They are not the same risk and must not share a switch.

A submission lands in `PENDING` and a moderator reviews it — there is a human gate between the
robot and the board. **An upvote is a direct, tier-weighted input to the canonical ordering with no
review step.** Automating that across ten boards scales one person's influence over entries they
never looked at, and we would be selling it. §2 makes weighted voting the signal the whole board
produces; feeding it automatically is not a feature, it is a defect with a price.

So: where a title is already on the board, the dashboard reports it and offers **one click** to
upvote. Where it is not, the queue submits.

### Creators get a labelled class and a switch — **decided**

Even respecting every limit, a creator who attracts ten broadcasters absorbs ten submissions an
hour they did not before. §9 forbids putting our revenue in proportion to their workload, and this
would do exactly that through a side door.

- Carried-over submissions **arrive labelled as such**, so moderators can judge them as a class
  rather than one at a time.
- A **board policy toggle** governs whether they are accepted at all. **Default on**, because
  opt-in strands the feature at zero reach and the label plus the existing review queue is real
  protection. Creators who dislike it turn it off in one place.

### Retroactive consolidation — **decided**

Someone who has been submitting by hand for months should not be punished for having started
before the feature existed. Gathering their unique past submissions into a list is the same queue
fed from a different query, and it is the natural onboarding into the feature.

Results per board — submitted, upvoted, already present, refused before, not eligible — land in
their existing submissions dashboard. This discloses nothing new: it is limited to boards they can
already submit to, and `duplicate: true` is already returned to submitters today.

### What is not achievable

- **Guaranteeing a carried-over suggestion is welcome.** It is a proposal, reviewed like any other.
- **Carrying to creators they do not support at a submitting tier.** Entitlement is the creator's.
- **Knowing what a board holds that the user cannot see.** The de-dupe answer is bounded by what
  the existing endpoint already discloses, and that boundary is not widened here.

## A.4 Following what moves — **decided in principle**

Notification when an entry moves on a board they follow, filtered on three axes:

- **By creator** — immediate for one board, silence for another they would rather check by hand.
- **By destination column** — only when something reaches `ACTIVE`, say, which is the question
  "who is lining up something I want to watch" in its most direct form.
- **By title or tag** — updates on two specific shows from a board without the rest of its output.

This is the feature that gives a patron a reason to open the app daily, and the filtering work is
reusable by A.3.

### In-app first. Email is a digest, and it is the first thing that costs money — **decided**

There is no mailer in the project: no dependency, no configuration, nothing. Email means a
provider, and with it deliverability, bounce handling and unsubscribe obligations. **This is the
first collision with the free-tier-only constraint, and it needs the engineer's decision before
anything is built against it.**

When it does arrive it is a **daily digest, never per-event**. A digest is cheaper by an order of
magnitude, fits inside a free provider tier, and is the better product regardless — nobody wants
an email per episode moved.

### Fan-out is a different order of magnitude — **decided**

`notifications.service.ts` fans out with `createMany` sized to **staff**. Followers are not that
size: one move on a popular board becomes thousands of rows. The coalescing already built for
flags — *does not repeat while the last one is unread* — is the right instinct to extend, and the
volume question must be settled in the plan rather than discovered in production.

### OPEN

- **Where filter rules are evaluated**: at fan-out (fewer rows, more work per move) or at read
  (cheaper writes, stores noise the reader never sees). Depends on follower counts nobody has yet.
- **Whether tagging is per-reader or shares a creator's themes.** Themes already exist per board;
  reusing them is cheaper but couples a reader's private interests to a creator's taxonomy.

## A.5 Sequencing

1. **Notification filtering, in-app only.** Felt daily, needs no new dependency, and its filtering
   is reused by carry-over.
2. **Fan-out and coalescing at follower scale**, forced by (1).
3. **Carry-over**, including the rejection check and the creator toggle.
4. **Email digests**, only once the free-tier question in A.4 has an answer.
5. **Cosmetics and settings sync**, at any point — they depend on nothing above.
