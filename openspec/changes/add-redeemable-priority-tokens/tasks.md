# Implementation Tasks

Each task ends green: `(cd apps/api && npx jest --config jest-e2e.json --runInBand)`,
`(cd apps/web && npx vitest run)`, `pnpm -r typecheck`, `pnpm format:check`, `pnpm audit:all`.
`pnpm -r test` does not typecheck. Commit per task; never commit red.

Every test is verified by mutation: break the thing, confirm the test that names it fails, restore.

## 1. Schema and the opt-in

- [ ] Migration: `CreatorPolicy.redeemTokensEnabled Boolean @default(false)`,
      `Tier.tokensPerPeriod Int @default(0)`
- [ ] Migration: `TokenBalance` — `(creatorId, userId)` unique, `available Int`
- [ ] Migration: `TokenLedger` — `creatorId`, `userId`, `kind` (`TIER_GRANT` | `CREATOR_GRANT` |
      `SPEND`), `amount Int`, `tierId?`, `periodKey?`, `reason?`, `redeemId?`, `createdAt`
- [ ] Migration: unique `(creatorId, userId, tierId, periodKey)` on `TokenLedger` where
      `kind = 'TIER_GRANT'` — the idempotency guarantee lives here, not in a service
- [ ] Migration: `Redeem` — `creatorId`, `recommendationId`, `userId`, `note`, `consumedAt?`
- [ ] Migration: `Recommendation.unconsumedRedeems Int @default(0)`
- [ ] Test: an existing board reads `redeemTokensEnabled = false` and every tier reads zero

## 2. Granting

- [ ] `periodKeyFor(date)` → `YYYY-MM` in UTC. Test: 31 Dec 23:00 UTC-5 is `2027-01`, not `2026-12`
- [ ] Grant on read: missing periods for the caller are granted before the balance is answered
- [ ] Test: granting twice for one period leaves one ledger row and one grant's worth of balance
- [ ] Test: a reader with memberships at two granting tiers is granted the **larger**, not the sum
      — the unique constraint is per tier and will not stop this on its own
- [ ] Test: a lapsed patron is granted nothing new and keeps what they had
- [ ] Test: a board with the feature off grants nothing, whatever the tiers say
- [ ] `POST /creators/:slug/tokens/grants` — creator only, whole number > 0, reason required,
      recipient need not be a patron
- [ ] Test: a moderator with every permission is refused
- [ ] Test: granting to a non-patron moderator succeeds

## 3. Spending

- [ ] `POST /creators/:slug/recommendations/:id/redeem` — note ≤ 200 chars
- [ ] Conditional decrement (`WHERE available > 0`), ledger row, redeem row, and
      `unconsumedRedeems` increment, all in one transaction
- [ ] Test: spending on `PENDING` is refused and no token is deducted
- [ ] Test: two concurrent spends from a balance of one — exactly one succeeds, balance is zero
- [ ] Test: a second spend on the same entry by the same reader is allowed and counts two
- [ ] Test: an entry id from another creator is a 404, not a 403

## 4. Priority on the board

- [ ] `unconsumedRedeems` on the board's entry projection, and the marker on the card
- [ ] Accepted column orders `isCreatorPick DESC, unconsumedRedeems DESC, <existing sort>`
- [ ] Test: ordering composes — a creator pick with no redeems still leads a redeemed entry
- [ ] Test: keyset pagination over a redeem-ordered column returns each entry exactly once
- [ ] Test: with the feature off, the column orders exactly as before (assert against a board
      whose policy is off, not against a snapshot)

## 5. Consuming, and telling the redeemer

- [ ] Consume inside `ModerationActionsService.changeStatus`'s existing transaction when the
      destination is `ACTIVE`: mark redeems consumed, zero `unconsumedRedeems`
- [ ] Test: moving to `ACTIVE` consumes every unconsumed redeem and clears the marker
- [ ] Test: moving to `REJECTED` and back to `ACCEPTED` leaves them unconsumed and the marker
      returns
- [ ] Test: a rolled-back status change consumes nothing
- [ ] A `REDEEM_PLAYING` notification to each redeemer, in the same transaction as the move
- [ ] Test: a redeemer who does not follow the board is still told
- [ ] Test: a redeemer who *does* follow gets one notification, not two
- [ ] Test: no notification when the move is to any status but `ACTIVE`
- [ ] `audit:enums` must still pass — a new `NotificationType` value has to be mirrored in
      `apps/web/src/api/types.ts` or the audit fails, which is exactly what it is for

## 6. Reading a balance

- [ ] `GET /creators/:slug/tokens` — own balance and ledger, granting missing periods first
- [ ] Test: asking for another reader's balance is refused as though they did not exist
- [ ] Test: staff see each redeem's note and who left it
- [ ] Test: the response is empty and harmless on a board with the feature off

## 7. The creator's settings

- [ ] Settings section: the switch, and a tokens-per-period field per tier
- [ ] The grant form: recipient, amount, reason
- [ ] Test: the whole section is absent for a moderator without `MANAGE_POLICY`
- [ ] Test: a board with the feature off renders no token UI anywhere on the board

## 8. The patron's side

- [ ] A redeem control on an accepted entry, shown only with a balance above zero and the feature on
- [ ] The balance, where a patron can find it, saying when the next grant lands
- [ ] Test: the control is absent at a zero balance rather than present and failing
- [ ] Test: the note is rendered as text — it is a stranger's words

## 9. Integrity

- [ ] A check asserting `SUM(ledger) = balance` per reader per creator, and a test that it fails
      when a balance is edited behind the ledger's back

## 10. Demo and journeys

- [ ] Seed: the feature **on** for Ada's board, a grant on the Producer tier, and a redeem already
      spent — so the mechanic differs visibly from its absence. Measure before choosing the
      numbers; §6 of the grouping spec was wrong for guessing instead
- [ ] e2e: Cal redeems an accepted entry, it leads the Accepted column, Ada plays it, the marker
      clears
- [ ] Walkthrough section, in the file's voice, naming what a token cannot do

## Before opening the PR

- [ ] Both design questions are answered (notify: yes; undo: no) — check nothing drifted from them
- [ ] All five verification commands, output quoted
- [ ] e2e against a rebuilt stack, with the running image confirmed to carry the change
