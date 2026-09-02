# Progress Tracker

## Current Status

Phase 1 is complete and merged. Phase 2 — the board experience — is designed in
`docs/superpowers/specs/2026-08-17-phase2-board-experience-design.md` and is
being built in sequence. Every sequenced step has shipped, including the
link/candidate model (design §4), which was split out of grouping rather than
dropped.

The verification baseline at the time of writing: **1045 API + 329 web + 42 e2e
tests passing**, typecheck clean across every package.

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

## Active Task

Nothing in flight, and nothing designed but unbuilt.

The Phase 2 sequence is complete, and so is **Amendment A** — every step of its
A.5, including the two features it added (carrying a list across boards, and
following what moves) and the email digests that were blocked on a provider
decision until it was made.

**Plan 20** then put every payment provider behind one `PaymentProvider` port
and added a second implementation that takes no money, so the whole product —
including buying premium — can be demonstrated end to end before anybody has a
merchant account. Both implementations pass one conformance suite, which is the
gate any future provider walks through.

What remains needs access this repository does not have, and each has a document:

|                                  |                                             |
| -------------------------------- | ------------------------------------------- |
| A Lemon Squeezy sandbox purchase | `docs/billing-sandbox-runbook.md`           |
| SPF and DKIM on a sending domain | `docs/email-setup.md`                       |
| `VITE_DONATION_URL`              | the donation page is built and switched off |

The first is still the most consequential, and plan 20 does **not** replace it.
The fake provider proves this codebase's own plumbing works; it says nothing
about whether Lemon Squeezy's real payload matches what the adapter expects.
Billing fails **closed but silent**, so a mismatch means a subscriber pays and
gets nothing, with nothing in the logs to say so. What has changed is that
nothing else is waiting on it — premium is demonstrable today, and switching to
the real provider is a config value with no code, migration or data change.

## Open Questions Blocking Work

| Question                                         | Blocks | Why it matters                                                              |
| ------------------------------------------------ | ------ | --------------------------------------------------------------------------- |
| Does email get a paid provider?                  | A.4    | The first collision with the free-tier-only constraint; blocks digests      |
| Should a reader be able to follow one entry?     | —      | Themes are categories; the original request was title-level (Amendment A.4) |
| Which permissions stay bundled under `MODERATE`? | —      | The five that exist cover today's endpoints                                 |

## Known Debt

- ~~**Web coverage is not wired.**~~ Both gates are live and **enforced in CI**,
  which `pnpm -r test` never did — each existed as a command nobody ran. Web
  sits at 90.2% lines / 85.8% branches with thresholds set just under, so it is
  a ratchet rather than a number to chase. `@vitest/coverage-v8` was approved
  and pinned to vitest's own version; the floating install pulled v4 against
  vitest 2.1.2.
- ~~`recommendations.service.ts` past the 300-line limit~~ — split into seven
  modules (plan 11); `hooks.ts` split into three. Two files remain over:
  `SubmitForm.tsx` (378) and `ReviewQueue.tsx` (345), each a deliberate stop
  with its reasoning recorded in `04_CODE_STANDARDS.md` §1.
- **Bounce and complaint handling is not built.** Providers suspend senders who
  ignore them. Not urgent: the free tier caps volume at 100 emails a day, and it
  needs Resend's webhook contract — the same unverified-shape problem billing
  had, where reading their documentation first found eight bugs across three
  attempts. Worth doing that before writing any of it.
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
