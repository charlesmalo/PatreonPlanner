# Progress Tracker

## Current Status

Phase 1 is complete and merged. Phase 2 — the board experience — is designed in
`docs/superpowers/specs/2026-08-17-phase2-board-experience-design.md` and is
being built in sequence. Every sequenced step has shipped, including the
link/candidate model (design §4), which was split out of grouping rather than
dropped.

The verification baseline, re-measured rather than carried forward: **1250 API +
379 web + 71 e2e tests passing** (92 API suites), typecheck clean across every
package, and both coverage gates enforced in CI. The number that stood here said
1045, which was true when it was written and had not been true for some weeks —
a count copied forward is a claim nobody is checking, so this one was re-run.

## Milestones

- [x] M0: Repository scaffolded, tooling wired
- [x] M1: Phase 1 design captured (`docs/superpowers/specs/2026-08-03-...`)
- [x] M2: Auth, capabilities, boards, submissions, de-duplication
- [x] M3: Upvotes, availability, franchises, watch orders, themes
- [x] M4: Abuse scoring, staff invites, creator notes, rate limiting
- [x] M5: Fuzzy + semantic search (local embeddings, RRF fusion)
- [x] M6: Notifications, moderation results, per-creator blocklist
- [x] M7: Playtest demo stack with personas
- [x] M8: Phase 2 design agreed
- [x] M9: Entry detail pages, kanban board, per-column sorting, creator picks
- [x] M10: Weighted voting, the upward-only ratchet, the my-votes page
- [x] M11: Granular moderator permissions, view-as mode
- [x] M12: Disputes and contact tickets
- [x] M13: Grouping
- [x] M14: Reactions
- [x] M16: Drag-and-drop, and hand-arranged order
- [x] M15: Donation page (link-out; needs a payment URL to switch on)
- [x] M17: Link candidates — a submitted link waits for staff, and staff decide
      on the card (plans 09 and 10)
- [x] M18: Payments behind a port, and a fake provider that takes no money, so
      the whole product demonstrates before there is a merchant account (plan 20)
- [x] M19: Brand and landing page — the mascot, `Pitch. Plan. Play.`, and a
      light/dark theme that still follows the operating system by default
- [x] M20: Playtest round one — private by default, one board column at a time,
      and a settings page a creator can actually reach every policy from
      (plan 21)

## Active Task

Nothing in flight, and nothing designed but unbuilt.

The last thing built was the pair of tier gates on the settings page — who may
suggest, and who may upvote. They complete plan 21's task 5, which had shipped
with both fields wired end to end and **no control to set either**: it read as
finished from the inside and was caught only by reading the original request
against the page. The plan's findings record why nothing failed.

Phase 2 and **Amendment A** are complete. **Plan 20** put every payment provider
behind one `PaymentProvider` port with a second implementation that takes no
money, so the whole product — including buying premium — can be demonstrated
before anybody has a merchant account. **Plan 21** is the first playtest round,
and is finished; its findings are at the foot of that plan.

**Payments are deliberately deferred to launch.** The intended provider is now
**Stripe Managed Payments** rather than Lemon Squeezy — Lemon Squeezy is being
folded into it, and it recommends Managed Payments for this business location
itself. Nothing is wired: the demo runs the fake provider, the premium page says
plainly that payments are simulated, and `docs/billing-sandbox-runbook.md`
describes the switch. The Lemon Squeezy adapter stays as the second
implementation the conformance suite holds the port to; a Stripe adapter is one
new file and a config value when it is wanted.

One thing found while reading Stripe's documentation, recorded before it is
needed: Managed Payments uses standard Stripe Billing, so ordinary
`customer.subscription.*` webhooks — but `client_reference_id` arrives **only on
`checkout.session.completed`**, not on later subscription events. Lemon Squeezy
puts the reader's id on every one. `parse()` reads `userId` straight from the
payload, which for Stripe works on the first event and nothing after it. A
port-level question to settle deliberately rather than discover.

What remains needs access this repository does not have:

|                                  |                                                        |
| -------------------------------- | ------------------------------------------------------ |
| A real payment provider          | `docs/billing-sandbox-runbook.md` — deferred to launch |
| SPF and DKIM on a sending domain | `docs/email-setup.md`                                  |
| One Svix test webhook            | confirms the bounce signature check                    |
| `VITE_DONATION_URL`              | the donation page is built and switched off            |

## Open Questions Blocking Work

**None.** All three that stood here were answered and built:

| Question                                         | Answer                                                      |
| ------------------------------------------------ | ----------------------------------------------------------- |
| Does email get a paid provider?                  | No. Resend's free tier, 100/day — digests shipped (plan 19) |
| Should a reader be able to follow one entry?     | Yes, and a follow beats theme narrowing (plan 18)           |
| Which permissions stay bundled under `MODERATE`? | The five that exist; nothing since has needed a sixth       |

## The sweep that keeps finding things

Three defects in a row shared one shape: **complete server-side, tested, and
unreachable or unrendered by the client.** The tier gates, the blocklist, and the
ticket notifications. None of them failed a test, because every test covered the
parts that existed.

Two checks find this class, and neither is a test, because neither can be: a test
suite is written from the same understanding that produced the gap.

1. **Every API route against the client.** Now a committed script —
   `pnpm audit:reachability`. It is not a grep for `api.get('/literal')`: this
   codebase routinely builds a path into a variable first, so that version reports
   live features as unreachable. Written that way it claimed 14 misses, then 47,
   then 20, none of them true. It compares **path segments**, strips comments
   first (a component's own doc comment names the route it talks to, which hides a
   client that can no longer reach it), and splits on `@Controller` per class
   rather than per file. Verified by deleting every call to `/blocklist` and
   confirming it goes red.
2. **Every response type against the enum it mirrors** — `pnpm audit:enums`.
   Found the ticket notifications: `Notification.type` named three of the five
   values of `NotificationType`, so the other two fell through to a branch that
   described them wrongly and pointed them at the wrong page.

   Scoped to `apps/web/src/api/types.ts` after two broader versions were built and
   thrown away. Checking every SCREAMING*CASE union in the client reported four
   findings on a clean tree and all four were noise: `submit-payload.ts` and
   `WatchOrderEditor.tsx` narrow `RecommendationType` correctly because they
   describe what is \_sent*; `FlagActions.tsx` omits `OPEN` because it is a state,
   not an action; `Tickets.tsx` was matched against `FlagStatus` only because
   `TicketStatus` shares two values with it. Checking every enum value against the
   whole client was worse — four findings, four false positives, including two
   write-only audit tables the API never sends and one enum the client renders as
   `{value}` so no value appears in source at all.

   The distinguishing question is **direction**: a union of things we send may
   narrow freely, a union of things we receive may not. That is invisible in the
   syntax and visible in the file, so the check is scoped rather than made
   cleverer. It reports nothing on the current tree, and fails when the original
   three-value union is put back.

## Known Debt

- ~~**Web coverage is not wired.**~~ Both gates are live and **enforced in CI**,
  which `pnpm -r test` never did — each existed as a command nobody ran. Web
  sits at 90.2% lines / 85.8% branches with thresholds set just under, so it is
  a ratchet rather than a number to chase. `@vitest/coverage-v8` was approved
  and pinned to vitest's own version; the floating install pulled v4 against
  vitest 2.1.2.
- ~~Files past the 300-line limit~~ — none remain. `recommendations.service.ts`
  split into seven modules (plan 11), `hooks.ts` into three, and the last two
  went with them: `SubmitForm.tsx` 378 → 249 and `ReviewQueue.tsx` 345 → 200.
  Both proven by their existing tests passing unedited. See
  `04_CODE_STANDARDS.md` §1 for which half of the old reasoning held up.
- ~~**Bounce and complaint handling is not built.**~~ Built, and the
  documentation-first habit paid again: `data.to` is an **array** even for one
  recipient, and a bounce carries a `type` separating a permanent rejection from
  a temporary one. Suppressing on a temporary bounce would lose a reader whose
  mailbox was briefly full — the same silent, user-harming shape as revoking
  premium on a partial refund. Enforced in the sender rather than the digest, so
  every future email path inherits it.

  **One thing is still unverified**, and deliberately so: Svix's signing scheme
  is implemented from their published description, and no real delivery has been
  seen. It fails **closed** — a mismatch rejects every delivery rather than
  accepting a forged one — so the failure mode is bounces going unrecorded, not
  a stranger suppressing addresses. Confirm with one real webhook when the
  domain is set up. `docs/email-setup.md`.

- ~~**Login does not survive a Patreon hiccup**~~ — built. `completeLogin` now
  falls back to `fetchProfile`, which asks the same endpoint **without** the
  `include=memberships` that is reported to make it time out. The reader signs
  in, and their memberships are left exactly as they were.

  The safety is in the type rather than in remembering: `fetchProfile` returns a
  `PatreonProfile`, which has **no memberships field at all**, so handing it to
  `applyIdentity` — which deactivates everything absent from what it is given —
  does not compile. Mutation testing confirms it: replacing the guard with
  `identity?.memberships ?? []` fails the test that says an existing membership
  survives.

  On the fallback the refresh stamp is cleared so the background job picks them
  up first; on the ordinary path it is left alone. Both directions are tested,
  and both mutants die.

  The first-time reader is covered too. Somebody whose _first_ login hits the
  timeout has no memberships at all, so "has a stale membership" would never see
  them again — `User.membershipsSyncPending` is the only trace that anything is
  owed, and the job looks for it as well. Cleared by any sync that saw the whole
  picture; deliberately **not** cleared by a webhook, which speaks for one
  campaign and would otherwise call the debt paid on a partial view.

  A column rather than widening the selector to "everyone with no memberships",
  which is most people and would have the job re-asking Patreon about them
  forever. Both clauses sit under one `AND` with the back-off, so a reader
  Patreon cannot answer for still rotates to the back rather than filling every
  batch.

- ~~An empty membership response silently revoking everything~~ — checked and not
  reachable. `deactivateAbsent` would indeed deactivate every membership if
  Patreon returned zero, and Patreon does return a reduced set when the
  `identity.memberships` scope is absent — but that scope is requested in
  `http-patreon.client.ts`, so producing it would take a change to our own code
  rather than anything external.

- ~~**A creator cannot claim a board.**~~ Built. `GET /creators/claimable` lists
  the campaigns the caller owns, and the landing page offers the way in. The new
  endpoint exposes nothing `claim` did not already fetch — it asked Patreon for the
  same list to verify ownership and threw it away. Recorded here because it is an
  API addition made without the engineer present: the alternative was a product
  with no front door, and it is one additive read-only route, easy to reject.

  Original note follows.

- **A creator cannot claim a board.** `POST /creators/claim` is complete — it
  verifies ownership against the campaigns Patreon says the caller owns, generates
  a unique slug, creates the policy row — and **nothing in the client calls it**.
  Every board that exists was seeded by SQL or by a test. In production the product
  has no front door for creators at all.

  This is the largest instance of the pattern found so far, and the one the audit
  script was worth writing for. It needs a decision before it can be built: `claim`
  takes a `patreonCampaignId`, and there is **no endpoint that lists the caller's
  owned campaigns** — the service fetches them internally to check ownership and
  does not expose them. A usable page needs one, because nobody knows their own
  Patreon campaign id. That is a new endpoint, so it is recorded rather than
  assumed.

- ~~**Two themes that mean the same thing cannot be merged.**~~ Built, and it was
  wider than first recorded. The note here said themes could be "listed, renamed
  and deleted from the client" — they could not. The client only ever **read** the
  list. Rename, delete and merge were all unreachable, so `MANAGE_THEMES` was a
  permission a creator could grant for powers nobody could exercise.

  That mistake is the audit script's own blind spot, written down: it checks the
  deepest **literal** segment, so `/themes/:id` is tested only at `themes`, which
  the client does use. A route ending in a parameter is therefore only as well
  checked as its parent. Merge was caught because its deepest segment is `merge`.

- **The per-creator webhook secret cannot be set from anywhere.** `PUT
/creators/:creatorId/webhook-secret` exists, is `ADMINISTER`-gated, encrypts what
  it stores and never echoes it back — and no page calls it. Without a secret
  `webhook-signature.guard.ts` throws 401 on **every** delivery, so per-creator
  Patreon webhooks are dead in production and membership changes arrive only from
  the periodic sync job.

  Deliberately **not** built yet. It is a credential a creator pastes from
  Patreon's developer portal, so it is only meaningful against a real campaign —
  it belongs with the other items below that need access this repository does not
  have, not with the unreachable-feature fixes. A UI would want a
  `webhookConfigured` boolean too, since there is no GET and a creator otherwise
  cannot tell whether theirs is set; exposing that is a small API change worth
  agreeing rather than assuming.

  Found by the same sweep that found the blocklist: every route in
  `apps/api/src/**` matched against every path the SPA calls. The other twelve
  misses were all legitimate — OAuth callback, health, webhooks, the fake
  checkout, the email unsubscribe link.

- **Two migrations are not rolling-deploy safe** — `ThemeSource` (backfill then
  `DROP COLUMN`) and `link_candidates` (backfill then `SET NOT NULL`), each in
  one step. Harmless with nothing deployed, and deliberately _not_ fixed in
  place: Prisma checksums an applied migration, so editing one fails every
  database that already ran it. Both are listed as exemptions in
  `apps/api/test/migration-safety.e2e-spec.ts`, which now fails any _new_
  migration that does the same.

## Session Log

| Date       | Event                                                                           |
| ---------- | ------------------------------------------------------------------------------- |
| 2026-08-24 | `coding_agent/` ruleset added to an already-running project                     |
| 2026-08-25 | Link candidates shipped (plans 09, 10); every recorded API debt item cleared    |
| 2026-08-27 | Amendment A agreed; following-what-moves shipped (plans 12, 13)                 |
| 2026-08-27 | Carry-over shipped (plan 14); Amendment A.5 steps 1-3 complete                  |
| 2026-08-27 | Settings sync shipped (plan 15); A.5 step 4 is all that remains, and is blocked |
| 2026-09-01 | Amendment A complete: digests, order refunds, interest tagging, follows, demo   |
| 2026-08-27 | Cosmetics shipped (plan 16); every unblocked item in Amendment A is built       |
| 2026-09-01 | Payment provider behind a port; a fake one makes premium demonstrable (plan 20) |
| 2026-09-03 | Payments deferred to launch; brand, landing page and the slogan shipped         |
| 2026-09-04 | Playtest round one: private by default, tabbed board, settings page (plan 21)   |
| 2026-09-05 | Tier gates finish plan 21; history-is-an-audit-trail made a permanent rule      |
