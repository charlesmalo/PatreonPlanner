# Progress Tracker

## Current Status

Phase 1 is complete and merged. Phase 2 — the board experience — is designed in
`docs/superpowers/specs/2026-08-17-phase2-board-experience-design.md` and is
being built in sequence. Every sequenced step has shipped, including the
link/candidate model (design §4), which was split out of grouping rather than
dropped.

The verification baseline, re-measured rather than carried forward: **1390 API +
603 web + 95 e2e tests passing** (108 API suites), typecheck clean across every
package, and both coverage gates enforced in CI. Measured on `main` @ `6a24967`; the two
commits since (`#141`) changed only `CLAUDE.md` and `.gitignore`, so no code moved.

This number has now been wrong twice. It said 1045 when the truth had moved on; it
was corrected to 1250, and by 2026-10-01 that was stale too — 140 API tests and 224
web tests behind. **A count copied forward is a claim nobody is checking.** Re-run
the five commands before editing this paragraph. Do not adjust it by reasoning about
what has been added since.

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
- [x] M13: Grouping — the API, and (later) the control that reaches it: a `Group`
      menu on every card and a drop band while dragging, same column only
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
- [x] M21: Grouped label filters — per-tab filtering, OR-groups formed by dragging
      one chip onto another (#131, #132, #134, #135)
- [x] M22: Redeemable priority tokens — a creator opts their board in, tiers grant
      per period, a patron spends one to mark an accepted entry Priority with a
      note, and the redeem is consumed when it plays (#137, #140). The first
      feature taken through OpenSpec end to end
- [x] M23: Board search — the fuzzy/semantic engine reaches readers at last, above
      the column tabs and across all four at once (#143)

## Active Task

**Nothing in flight.** `main` @ `54e432a`, repo private, no open PRs, working tree clean.

Board search shipped (#143), closing the oldest user-facing debt item.

### Next up, ranked

1. **19 vulnerability advisories, 7 high.** Down from 24 and 9; the two _reachable_ ones were
   fixed and the rest traced and left. The item least comfortable to carry into a launch, and
   the one that has sat longest.
2. **Availability is answered for one region, server-wide** — see Open Questions. Needs the
   engineer's decision, not an implementation choice.
3. **A ticket notification lands on the list, not the ticket.** Needs a
   `/c/:slug/tickets/:id` route that does not exist. Fine at ten tickets, not at three hundred.
4. **Two migrations are not rolling-deploy safe.** Matters at the first real deploy.
5. **Conditional:** harden the flaky `journey.spec.ts` moderator-notes test if it recurs.

## Open Questions Blocking Work

**One, and it does not block anything shipped.**

**Availability is answered for one region, server-wide.** The board and the entry page both
embed `availability` for `AVAILABILITY_REGION_DEFAULT`, so a patron in France reads "Where to
watch (US)" and a list of US offers. `GET /creators/:slug/catalog/titles/:id/availability` takes
a `region` and is the only thing that can answer otherwise; nothing in the client passes one,
which is why it sat unreachable. Three ways out, and the choice is the engineer's because each
costs something different:

| Option                                      | Cost                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| Leave it                                    | Wrong answer for every reader outside the default region                     |
| Reader picks a region, stored as preference | One more setting; the refresh job gains a row per region asked for, forever  |
| Infer from the request                      | Needs geo-IP — a dependency, and a privacy question this project has avoided |

The refresh obligation is the part worth weighing: `AvailabilityQuery` already refuses regions
the deployment does not serve, with the comment that an open region set lets one caller create a
permanent row and a permanent refresh obligation for every country on earth. Whichever way this
goes, the bounded set stays bounded.

All three questions that previously stood here were answered and built:

| Question                                         | Answer                                                      |
| ------------------------------------------------ | ----------------------------------------------------------- |
| Does email get a paid provider?                  | No. Resend's free tier, 100/day — digests shipped (plan 19) |
| Should a reader be able to follow one entry?     | Yes, and a follow beats theme narrowing (plan 18)           |
| Which permissions stay bundled under `MODERATE`? | The five that exist; nothing since has needed a sixth       |

## A demo too uniform to show a feature

Three parts of M10 — tier weights, weighted ranking, the upward-only ratchet — were
built, tested, reachable and **invisible in the demo**, for one reason: the personas
declared `amountCents` and no `tierIds`, so no membership bound to a `Tier`. A vote
with no tier is worth one whatever the weights say, so `weightedScore` equalled
`upvoteCount` on every entry, no weight could change anything, and `couldImprove`
was always zero.

That is a different failure from an unreachable route. Nothing was missing and
nothing was wrong; the data was simply too uniform for any difference to appear. A
reader could use every control and conclude the feature did nothing.

The question that finds it: **for each mechanic, is there data in the demo where it
would visibly differ from its absence?** Uniform weights, votes all cast at the
current tier, zero reactions — each looks like working software and demonstrates
nothing. Producer is seeded at 3, one of Cal's votes is deliberately stale, and two
entries carry reactions including one premium, precisely so each mechanic differs
from its own absence.

Worth knowing the limits of it. The same question asked about reactions produced a
marginal change and a false premise — §10 already covered them and its steps
already worked. The method finds the cases where a feature _cannot_ be shown; it
says little about ones merely needing a step first.

## Permissions: the sweep that is not a script

Four changes came out of one question, asked after the first fix looked finished:
**for every endpoint that names a permission, does the control reaching it check
the same one?**

| permission       | endpoints | state before                 |
| ---------------- | --------- | ---------------------------- |
| `MOVE_ENTRIES`   | 6         | one control gated, three not |
| `HANDLE_REPORTS` | 4         | no client gate at all        |
| `WRITE_NOTES`    | 1         | no client gate at all        |
| `EDIT_ENTRIES`   | 2         | `LinkCandidates` only        |
| `MANAGE_THEMES`  | 3         | correct                      |
| `MANAGE_POLICY`  | 2         | correct                      |

Every gap had the same shape: a control offered on `canModerate` alone, calling an
endpoint that demands a named permission, answering 403 and leaving the entry where
it was. An invite grants a staff row and nothing else, so this was the **default**
experience for an invited moderator, not an edge case.

**It is deliberately not a script.** The weak version — does the client mention
each permission anywhere — reports all six as covered even when a permission is
only named in `types.ts` and the grant checkboxes on the staff page. It said
exactly that while `MOVE_ENTRIES` had no gate. Answering it properly needs the call
graph from control to endpoint, which is not statically available here, and a check
that cries wolf on a clean tree gets ignored or, worse, believed. Two audits were
built and thrown away this session for that.

Run it by hand when a permission is added or a control moved: list
`@RequirePermission` by permission, find the client control that calls each
endpoint, and check the gate names the same one. Two components rendering the same
control are two answers — the queue's `StatusControl` and the card's are separate
instances, and fixing one did nothing for the other.

**Eight test fixtures had encoded the old behaviour**, and the API's own
capabilities test is the one to remember: written _specifically_ so the client
could avoid rendering controls the API refuses, it proved the payload correct and
never that anything consumed it. A test written beside a bug tends to pin the bug.

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

### Then the checks themselves turned out to have the shape they hunt

Both audits passed on a tree where the thing they existed to catch was absent.
Neither could tell "no drift" from "nothing to check", which is the same defect
they were written to find, one level up.

- **`audit:enums` matched unions, so a field typed `string` was skipped in
  silence.** Replacing `Notification.type` — the union the script was written to
  protect — with `type: string` left it printing "every union covers the enum it
  mirrors" and exiting 0. The six mirrored enums are pinned in `MIRRORED` now, and
  the success line counts what it checked rather than reading identically whether
  it examined six unions or none. `types.ts` types four server-owned enums as bare
  `string` today, so the shape was never hypothetical.

- **`audit:reachability` matched the deepest path segment only.**
  `GET /creators/:slug/catalog/titles/:id/availability` counted as reached because
  `availability` occurs all over the client — `AvailabilityBadges` renders a field
  of that name — while nothing had ever built a path containing `catalog/titles`.
  Requiring every literal segment was measured against a clean tree before being
  adopted: exactly one new finding, and no false alarms.

  That one finding was a live defect. `findOne` returned `BOARD_ONLY_DEFAULTS`, so
  an entry's own page — the URL notifications point at — carried
  `availability: null`, `themes: []`, `reactions: []` and `following: false` for
  an entry the board renders in full. `following` did more than omit:
  `FollowButton` seeds its state from it, so a reader who followed something read
  "Follow" on its page and pressing it followed again.

**The lesson generalises past these two.** A check that only reports what it finds
wrong cannot distinguish a clean tree from an empty one. Every one of these should
say how much it examined, and pin what it expects to examine.

## An aggregate cannot see a file

The same defect as the two audits above, one level up again: **a global coverage gate cannot
tell "every file is decently covered" from "most files are excellent and three are zero."**
Both read as 91%.

Measured on the web side, which passed its 90% gate at 91.09% lines:

| file                         | statements | coverage |
| ---------------------------- | ---------- | -------- |
| `src/routes/Tickets.tsx`     | 157        | **0%**   |
| `src/routes/LandingPage.tsx` | 37         | **0%**   |
| `src/App.tsx`                | 33         | **0%**   |

None of the three had a test file at all. `Tickets.tsx` — the moderator's inbox — is the
largest route in the client and had exactly one e2e journey through its happy path and nothing
else: no load failure, no empty state, no resolved rendering, no status filter, and nothing on
the rule that decides whether picking a resolution overwrites what a moderator has typed.

A fourth, found the same way and worth more than its size: **`src/components/safe-url.ts`**, the
client half of an XSS boundary, sat at 75% lines / 50% branches with its `catch` measured at
**0 executions across all 458 tests**. All three consumers test `javascript:` against their own
markup — which is why the protocol check was covered — and none had ever handed it a string that
is not a URL at all.

Closed: 25 tests, every one verified by mutation. Web coverage moved 91.09% → 95.21% lines,
90.55% → 91.80% functions, and **no file sits at 0%**. The new per-file floor is 81.81%
(`drag.ts`, 11 statements).

**Nothing was found wrong in any of the four.** The finding is the hole, not a defect — which is
the honest and less satisfying half of the result, and the reason to write it down rather than
claim a save.

The API side was measured the same way and is healthy: 96.8% global, nothing at 0%, 14 of 128
files under 90%. The worst real one is `http-patreon.client.ts` at 74.57% lines / 60.97%
branches — its error and retry paths, which only a live Patreon exercises. The rest are
three-statement abstract providers whose percentage is an artifact of their size.

**The structural half is fixed too.** The engineer took the ~75% floor, and it is
`scripts/audit-coverage-floor.mjs`, wired inside each package's `coverage` script so it cannot be
skipped by running coverage on its own.

Two gates now, answering different questions and holding different numbers: the aggregate asks
whether the codebase is tested well, the floor asks whether any single file is abandoned.

**Lines and statements only.** Measured before choosing: at 75%, branches would fail 8 web and 12
API files, functions 4 and 9, because on a small file those percentages are dominated by how many
branches the file happens to have rather than by neglect. A floor that fires on ordinary
variation is one people learn to bypass.

**A script, because neither runner can express it.** Vitest's glob thresholds are aggregate over
the matching set — measured, not assumed: a catch-all glob at 99.99% reports 95.21%, the global
number, and `perFile` inside a glob group is ignored. Jest subtracts glob-matched paths from the
global bucket, so a catch-all glob there would empty the 90% gate beside it.

Files under 10 statements are exempt and **counted out loud**; a percentage over three statements
is arithmetic, not testing. **Except at zero** — no size excuses a file with nothing covered,
since `safe-url.ts` is 8 statements and was one of the four finds.

Adding it cost two more findings, both the same shape as the first four and neither failing
anything: `HttpPatreonClient.refreshTokens` and `fetchProfile` were **wholly uncovered** — every
running system uses `FakePatreonClient`, so the real one is exercised only against Patreon
itself — and `ResendSender.send`, the only file that knows which email provider this is, had
never been called by a test. Both are covered now; the Patreon client went 74.57% → 100% lines
and 60.97% → 92.68% branches, and the API aggregate 96.8% → 97.3%.

**The allow-list is empty on purpose.** An allow-list carrying an entry from birth is a gate
negotiated against an existing violation, which §3 of `07_TESTING_STANDARDS.md` says is how gates
die. The Patreon client was the one candidate and it was covered instead.

Verified by mutation, five ways: a large file forced to 0% is named; a _small_ file forced to 0%
is named too, rather than excused by the size floor; a missing summary and an empty one both
refuse with exit 2 rather than reporting a clean tree; and — the one that matters — deleting
every `Tickets.tsx` test and re-measuring for real makes the floor fire at 8.91% **while the
aggregate gate still passes at 92.63%**. That is the whole argument for the second gate, run
rather than asserted.

## 409 means "trying again cannot work", and three screens said "Try again"

The last of the sweep ideas: **for each error the API returns, can the reader tell what to do
from what the client shows them?**

The client discards the server's body on purpose — `ApiError` carries the status and nothing else,
with three comments citing design §9. That is not the defect, and §9 is not what it first looks
like: its rule is **no user-enumeration** and no stack traces, SQL or secrets. Refusing a
moderator's action because somebody else got there first enumerates nobody. The design already
admits one carve-out on exactly this ground — `retryAt`, "for the one case where the status alone
cannot say enough".

So the question is narrower: where does the status alone leave the reader unable to act? 409 is
where, because **409 is the one status that means trying again cannot work**, and three handlers
answered it with "Try again".

| where           | the API says (409)                         | the client said                         | why it was wrong                                                                                                                   |
| --------------- | ------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `StatusControl` | entry changed while you were looking at it | _"That move is not allowed from here."_ | **Actively misdirecting** — the move may be perfectly legal from where the entry now is                                            |
| `RedactForm`    | entry changed while you were editing it    | _"…Try again."_                         | The update is conditional on the text shown, so retrying fails identically — and would redact text the moderator can no longer see |
| `FlagActions`   | that report has already been handled       | _"…Try again."_                         | Already resolved; no number of retries changes that                                                                                |
| `Themes` rename | a theme with that name already exists      | _"That did not save."_                  | Silent about the clash, so the creator retypes the same taken name                                                                 |

**The pattern was already established and simply not applied.** Four other places get it right —
`NoteEditor`, the staff invite limit, `Blocklist`, `ClaimBoard` — each naming the actual reason.
The misses are all in moderation, which is the one surface where two people act on the same object
at once, so conflicts there are ordinary rather than exotic.

### The one that needed more than wording

`POST /recommendations/:id/status` answers 409 for **two** reasons needing opposite remedies: an
illegal transition (pick a different move) and a lost race (reload, because the move you asked
for may be fine from where it is now). The status cannot carry that, so the conflict now sends a
machine-readable `reason: 'STALE'` and `ApiError` reads it, exactly as it reads `retryAt` — a
short code the client turns into its own wording, never the server's prose. An illegal transition
deliberately carries no code, so a bare 409 still means what it always meant and every existing
handler keeps working untouched.

**It cannot be asserted over HTTP.** The guard fires only when two requests genuinely overlap: if
they serialize, the second re-reads the new status and either transitions legally or fails the
map with a reasonless 409. The existing concurrency test asserts `[200, 409]` for precisely that
reason. So the two conflicts are driven directly against the service with a stubbed client, which
is the only deterministic way to assert _which_ 409 comes back.

### Two claims withdrawn before they were written down

`StaffPage` looked like two more of the same — "An owner already holds every permission" and
"A creator must keep an owner", both answered with "Try again". **Neither is reachable.** The page
already hides the checkboxes and the remove button on an owner's row ("a button that cannot work
is a lie"), and no endpoint promotes a moderator to owner, so the staff list cannot go stale in
the way that would expose them. They are defence in depth, and the fix written for them was
reverted rather than shipped as an invented finding.

That is the same error this tracker records once already, with the reaction limit that was
"four presses away" and was actually sixty.

## Grouping had no client, and the route audit could not see it

**Closed.** The control was built; see _Known Debt_ for what the deferral note got wrong. The
audit limitation below stands exactly as written — it is why nothing reported this for as long as
it was true.

### The original note

Found while tracing which endpoints return which errors, and **not an error-path finding at all**:
`POST /creators/:slug/recommendations/:id/group` and its `DELETE` have **no caller anywhere in the
client, and no e2e coverage.** M13 is a shipped milestone that is reachable only from a test.

`audit:reachability` does not report it, and is not broken: its header already names this exact
limitation. The route's segments are `creators`, `recommendations` and `group`, and `group`
appears in the client inside `groupCount` — a notification field. A segment collision, silent by
construction, which the script says plainly it cannot defend against.

**Not built**, for the reason the board-search debt gives: grouping is a new reader surface — what
a group looks like on a board, how you make one, what happens to the cards — rather than a control
missing for a decision somebody can already make. Recorded in _Known Debt_.

## Known Debt

- ~~**Grouping is built, tested, and unreachable.**~~ Built, and **the note that deferred it was
  wrong on its central claim**. It said grouping "invents a board surface — what a group looks
  like, how you make one, what happens to the cards" and so was a product decision rather than
  wiring.

  The rendering already existed. `present()` exposes `groupHeadId` as `parentId`, `buildTree`
  nests on it, and `BoardColumn` renders children recursively — so a group made through the API
  would have drawn correctly the whole time, with the head carrying the de-duplicated total. The
  TMDB-implied parents on the same field were producing exactly that rendering in production.

  Only the control was missing, which is the #117 shape, not a new surface. The claim was made by
  reading the endpoints and the debt notes rather than the read path; one `grep` for `parentId`
  would have settled it.

  What it actually took: a `GroupControl` menu, a drop band on the board, and one API field.

  **`parentSource` exists because `parentId` merged two things.** A staff group and a
  catalogue-implied nesting were "the same answer" while nothing acted on them. A control that
  undoes a group has to tell them apart — `DELETE :id/group` returns early on a catalogue-implied
  child, so an Ungroup offered on `parentId` alone would have done nothing on half the cards it
  appeared on.

  **Same column only, which is narrower than the API allows.** The board fetches one status at a
  time and `buildTree` promotes any child whose head is absent, so a cross-column group draws the
  child as an ordinary card while its votes count toward a head the reader cannot see. The client
  offers the honest subset.

- ~~**A board has no search, though the API has one.**~~ Built (#143). A search box sits above
  the column tabs, and every result names the column it is in. **Above the tabs deliberately:**
  the endpoint takes no status filter and returns matches from all four columns, so inside a tab
  it would answer a narrower question than it was asked without saying so.

  Worth keeping: the route audit could not see this gap. `similar` counted as _reached_ the
  whole time, because the submit form's duplicate hint called it — reachability answers "does
  any caller exist", not "can a reader get here".

  The endpoint's own comments are written for a reader using it directly: _"returns only entries
  the caller could already read on the board"_, and gating it higher _"would deny a reader the
  ability to search a board they are allowed to read"_.

  **Not built, because it is a new reader surface rather than a missing entry point.** Everything
  else closed this week wired up a control the API already implemented for a decision somebody
  could already make. This one invents a screen: where results appear, what happens to the column
  tabs while searching, and whether a search result is a card or a row. The Phase 2 design lists
  "searching" among the things never withheld from free users, which settles the pricing and not
  the surface.

  Worth knowing what it costs to leave: a board can be narrowed by column and by theme, and by
  nothing else. That is fine at ten entries and not at three hundred.

- **A ticket notification knows which ticket, and still lands the reader on the list.**
  `NotificationPayload.ticketId` is sent on every `TICKET_RAISED` and `TICKET_RESOLVED` and read
  by nothing. `destinationFor` sends both to `/c/:slug/tickets`, and that route takes only
  `:slug` — there is no way to address one ticket.

  **Not built, because it needs navigation that does not exist.** Either a `/c/:slug/tickets/:id`
  route, or an anchor plus a scroll-into-view once the list loads, since the hash lands before the
  tickets arrive. Both are product decisions about what a reader sees, not wiring.

  Cost of leaving it: a moderator told about one message opens a page of them and looks for it.

- ~~**Cross-language alias matching has no producer.**~~ Built. `fetchStructure` now returns
  aliases from TMDB's `alternative_titles`, and enrichment upserts them — idempotently, because a
  title is re-enriched every time it is bound to another board and duplicate rows would skew the
  lexical arm toward whichever title had been suggested most often.

  Capped at 8 per title. A popular film carries dozens of near-duplicate alternative titles, and
  every one lands in a trigram index the search joins, so an uncapped list would let one title's
  aliases crowd the results for everything else.

  **A title enriched before this change does not gain aliases on its own.** The job only looks at
  `enrichedAt: null`. In a deployment that resolves itself — re-binding a title clears the stamp —
  but a title nobody suggests again stays without. Unlike the embedding recipe, this needs no
  version marker: missing aliases are incomplete, not _wrong_, so there is nothing to invalidate.

  Verified in the demo: searching **千と千尋の神隠し** finds an entry titled "Spirited Away".

  Original note follows.

- **Cross-language alias matching has no producer.** `TitleAlias` has a schema, a dedicated
  trigram index, a join in the search query's lexical arm, and a place in the embedding passage.
  **Nothing writes a row.** The only references outside the read path are two test files, and both
  create the rows they then match against — so the feature is covered by tests and inert in every
  running system.

  Found by asking why the demo had zero aliases, after the same question about embeddings turned
  out to be five bugs deep. The comment claiming aliases were "the one piece of cross-language
  signal already stored" has been corrected; it was not true.

  **Not built, because it is an integration decision rather than a gap.** The producer would be a
  new upstream call — TMDB's `alternative_titles` endpoint — meaning a provider method, a fake and
  a demo-stub fixture, wiring into enrichment, and one more request per title enriched. Everything
  else closed this session made an existing capability reachable; this one adds a capability. The
  read side stays as it is: correct, and free against an empty relation.

  Worth knowing what it costs to leave: a board whose patrons search in another language gets
  nothing from the lexical arm, and the semantic arm only helps once `Title.overview` is populated
  in the language they searched in — which it is not.

- ~~**Semantic search matches names, not meaning.**~~ Built. The embed job's passage is now
  name, aliases **and** overview, and the column stores a signature — `model#v2` — so changing the
  recipe re-embeds rather than mixing two vector spaces. Measured again afterwards: plot
  descriptions moved from 0.219–0.221 to 0.138–0.199, and the floor moved to 0.205.

  **The margin is 0.006 wide, and the first number published for it was wrong.** It was measured
  from eleven queries over three titles and reported as roughly 0.015. Widening the set to 28
  queries over six titles both shrank the gap — should-match worst 0.2060, should-not best 0.2118 —
  and showed the chosen 0.205 rejecting a fair query ("a child working to rescue her parents"). The
  floor is 0.208 now, set toward recall because missing a duplicate is the failure this feature
  exists to prevent.

  The claim that justifies setting it toward recall — that the trigram arm independently catches
  anything matching by spelling — was repeated in several commit messages before anybody checked
  it. Checked now, with the provider switched off so the vector arm returns nothing at all:
  `sprited away`, `perfect blu` and `totoro` all still find their entries; the two plot
  descriptions find nothing, which is correct, because matching those is the other arm's job. So a
  floor set slightly tight costs meaning-matches and never spelling-matches, as claimed.

  A first attempt at that measurement was wrong and worth recording: clearing the `embedding`
  column looked like it disabled the vector arm, and the embed job refilled every row within
  seconds. The queries that then "proved" trigram could match a plot description were running
  against a live vector index. Disabling the provider is the only way to hold that arm still.

  The lesson is about the sample, not the constant: a threshold chosen from a handful of examples
  will look comfortable, because a handful of examples rarely contains the awkward case. It will
  narrow further as a board grows. Treat a rise in wrong "already on the board?" prompts as the
  signal to re-measure.

  Original note follows.

- **Semantic search matches names, not meaning.** `EmbedTitlesJob` builds its passage from
  `Title.name` plus aliases and never reads `overview`, so the vector arm buys cross-language
  surface forms and misspellings — real value — and cannot match a plot description at all.
  Measured against the demo's own titles: name-ish queries land at 0.066–0.138 cosine distance,
  plot descriptions at 0.219–0.221, and _nonsense_ at 0.204. A plot query is further away than
  some gibberish, so no threshold separates them.

  Embedding the overview would change that, and it is a retrieval decision rather than a tuning
  one — bigger passages, a re-embed of every row, and a different distance profile that would need
  `EMBEDDING_MAX_DISTANCE` measured again. Recorded rather than done.

  **This corrects a claim made in PR #83**, which said the overview is what the embedding is
  computed from. It is not. The overview refresh in that PR is still right — the comment beside it
  had promised the refresh for a long time and the code did not do it — but the embedding
  invalidation it added was dead weight and has been removed.

- **5 moderate advisories against production dependencies**, down from 22 (7 high,
  12 moderate, 3 low). **Every high is gone**, and every low. The high set was one
  package's subtree: `@huggingface/transformers` pulling `adm-zip` and `sharp`.

  Cleared by `pnpm.overrides` — pinning `adm-zip`, `sharp`, `qs`, `body-parser`,
  `cookie`, `multer` and `uuid` to patched versions — plus `@nestjs/common`
  10.4.4 → ^10.4.16, the one direct dependency with a fix inside its own major.

  Overriding under `transformers` is the part that needed proving rather than
  assuming: the test suites never load the real model, so they cannot tell whether
  `sharp` or `adm-zip` broke it. `pnpm --filter @app/api verify:embeddings` does,
  and all six checks pass on the overridden tree.

  What remains, and why each is left:

  | Advisory       | Needs       | Why not now                                                          |
  | -------------- | ----------- | -------------------------------------------------------------------- |
  | `@nestjs/core` | `>=11.1.18` | No fix inside 10.x. A major framework upgrade is the engineer's call |
  | `react-router` | `>=7.18.0`  | No fix inside 6.x. Same — a major upgrade of the router              |
  | `file-type` ×2 | `>=21.3.2`  | **Unreachable**, and arrived _with_ the `@nestjs/common` fix         |

  `file-type` is worth the detail. It reaches the tree through `@nestjs/common`'s
  file-validation surface, and this API has no upload path at all — no
  `FileInterceptor`, `ParseFilePipe`, `FileTypeValidator`, nor any use of `multer`
  in `src`. Forcing it to v21 means forcing an ESM-only package into a CommonJS
  runtime on a path no test exercises, so a break would surface in production and
  nowhere else. Trading a real runtime risk for an unreachable advisory is a bad
  deal; it is left, deliberately.

- ~~**Webhooks never reached the API through the deployed origin.**~~ Fixed. nginx
  forwarded `/api/` and `/auth/` and not `/webhooks/`, so every Patreon and Resend
  delivery fell to the SPA fallback and was answered by `index.html` — a 405 to the
  sender. The dev server had the same gap, so it was consistent rather than a
  drift, and consistently wrong.

  Nothing looked broken from inside: memberships arrived at the next sync instead
  of immediately, and the settings page correctly displayed a URL nothing was
  listening on. Found by curling the URL that page shows rather than trusting it,
  immediately after building the page that shows it.

  Guarded by `e2e/tests/webhook-routing.spec.ts`, which distinguishes "the API
  rejected it" from "nginx served the SPA" by status **and** content type, and then
  delivers a correctly signed body for a 204 — that last one is also the check that
  the proxy passes the raw bytes through unaltered, since the signature is an HMAC
  over the body.

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

- ~~**The per-creator webhook secret cannot be set from anywhere.**~~ Built.
  `GET :creatorId/webhook-secret` answers `{ configured }` — never the value, and
  never a prefix of it, since any prefix is a head start. The settings page shows
  the delivery URL alongside it, because the board id is in that URL and a creator
  has no other way to learn it.

  Writing it found a bug of exactly the kind the feature exists to prevent: the
  first version showed `/api/v1/webhooks/patreon/:id`, and webhook routes are
  **excluded from the global prefix** on purpose — the URL is registered with
  Patreon and must not move when the API version does. A creator following it would
  have had every delivery fail with nothing looking broken. The unit test matched a
  substring and passed on the wrong URL; the integration test that posts a signed
  body caught it.

  Original note follows.

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
| 2026-09-20 | Grouped label filters shipped (#131, #132, #134, #135)                          |
| 2026-09-28 | Redeemable priority tokens shipped (#137); demo persistence fixed (#138)        |
| 2026-09-28 | First OpenSpec change archived (#139) — promoting its spec exposed #140         |
| 2026-10-01 | CLAUDE.md records which spec mechanism is in use (#141); baseline re-measured   |
| 2026-10-02 | Board search shipped (#143) — the search engine finally reaches readers         |
