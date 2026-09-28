# Implementation Tasks

Each task ends green: `(cd apps/api && npx jest --config jest-e2e.json --runInBand)`,
`(cd apps/web && npx vitest run)`, `pnpm -r typecheck`, `pnpm format:check`, `pnpm audit:all`.
`pnpm -r test` does not typecheck. Commit per task; never commit red.

Every test is verified by mutation: break the thing, confirm the test that names it fails, restore.

## 1. Schema and the opt-in

- [x] Migration: `CreatorPolicy.redeemTokensEnabled Boolean @default(false)`,
      `Tier.tokensPerPeriod Int @default(0)`
- [x] Migration: `TokenBalance` — `(creatorId, userId)` unique, `available Int`
- [x] Migration: `TokenLedger` — `creatorId`, `userId`, `kind` (`TIER_GRANT` | `CREATOR_GRANT` |
      `SPEND`), `amount Int`, `tierId?`, `periodKey?`, `reason?`, `redeemId?`, `createdAt`
- [x] Migration: unique **`(creatorId, userId, periodKey)`** on `TokenLedger` — the idempotency
      guarantee lives here, not in a service. **Built without `tierId`, deliberately:** including
      it lets a reader who upgrades mid-period be granted a second time, because the new tier
      makes a new key. Measured at 1 + 3 = 4 tokens for one month by upgrading and downgrading.
      Recorded in the schema, the migration and the service so nobody re-adds it
- [x] Migration: `Redeem` — `creatorId`, `recommendationId`, `userId`, `note`, `consumedAt?`
- [x] Migration: `Recommendation.unconsumedRedeems Int @default(0)`
- [x] Test: an existing board reads `redeemTokensEnabled = false` and every tier reads zero

## 2. Granting

- [x] `periodKeyFor(date)` → `YYYY-MM` in UTC. Test: 31 Dec 23:00 UTC-5 is `2027-01`, not `2026-12`
- [x] Grant on read: missing periods for the caller are granted before the balance is answered
- [x] Test: granting twice for one period leaves one ledger row and one grant's worth of balance
- [x] ~~Test: a reader with memberships at two granting tiers is granted the larger, not the
      sum~~ — **moot in this schema.** `Membership` is unique on `(userId, creatorId)`, so a
      reader holds at most one tier per board and the case cannot arise. What replaces it is the
      upgrade case above, which *can*: `token-ledger-integrity` asserts one ledger row survives a
      mid-period tier change
- [x] Test: a lapsed patron is granted nothing new and keeps what they had
- [x] Test: a board with the feature off grants nothing, whatever the tiers say
- [x] `POST /creators/:slug/tokens/grants` — creator only, whole number > 0, reason required,
      recipient need not be a patron
- [x] Test: a moderator with every permission is refused
- [x] Test: granting to a non-patron moderator succeeds

## 3. Spending

- [x] `POST /creators/:slug/recommendations/:id/redeem` — note ≤ 200 chars
- [x] Conditional decrement (`WHERE available > 0`), ledger row, redeem row, and
      `unconsumedRedeems` increment, all in one transaction
- [x] Test: spending on `PENDING` is refused and no token is deducted
- [x] Test: two concurrent spends from a balance of one — exactly one succeeds, balance is zero
- [x] Test: a second spend on the same entry by the same reader is allowed and counts two
- [x] Test: an entry id from another creator is a 404, not a 403

## 4. Priority on the board

- [x] `unconsumedRedeems` on the board's entry projection, and the marker on the card
- [x] Accepted column orders `isCreatorPick DESC, unconsumedRedeems DESC, <existing sort>`
- [x] Test: ordering composes — a creator pick with no redeems still leads a redeemed entry
- [x] Test: keyset pagination over a redeem-ordered column returns each entry exactly once
- [x] Test: with the feature off, the column orders exactly as before (assert against a board
      whose policy is off, not against a snapshot)

## 5. Consuming, and telling the redeemer

- [x] Consume inside `ModerationActionsService.changeStatus`'s existing transaction when the
      destination is `ACTIVE`: mark redeems consumed, zero `unconsumedRedeems`
- [x] Test: moving to `ACTIVE` consumes every unconsumed redeem and clears the marker
- [x] Test: moving to `REJECTED` and back to `ACCEPTED` leaves them unconsumed and the marker
      returns
- [x] Test: a rolled-back status change consumes nothing
- [x] A `REDEEM_PLAYING` notification to each redeemer, in the same transaction as the move
- [x] Test: a redeemer who does not follow the board is still told
- [x] Test: a redeemer who *does* follow gets one notification, not two
- [x] Test: no notification when the move is to any status but `ACTIVE`
- [x] `audit:enums` must still pass — a new `NotificationType` value has to be mirrored in
      `apps/web/src/api/types.ts` or the audit fails, which is exactly what it is for

## 6. Reading a balance

- [x] `GET /creators/:slug/tokens` — own balance and ledger, granting missing periods first
- [x] Test: asking for another reader's balance is refused as though they did not exist
- [x] Test: staff see each redeem's note and who left it
- [x] Test: the response is empty and harmless on a board with the feature off

## 7. The creator's settings

- [x] Settings section: the switch, and a tokens-per-period field per tier
- [x] The grant form: recipient, amount, reason
- [x] Test: the whole section is absent for a moderator without `MANAGE_POLICY`
- [x] Test: a board with the feature off renders no token UI anywhere on the board

## 8. The patron's side

- [x] A redeem control on an accepted entry, shown only with a balance above zero and the feature on
- [x] The balance, where a patron can find it, saying when the next grant lands
- [x] Test: the control is absent at a zero balance rather than present and failing
- [x] Test: the note is rendered as text — it is a stranger's words

## 9. Integrity

- [x] A check asserting `SUM(ledger) = balance` per reader per creator, and a test that it fails
      when a balance is edited behind the ledger's back

## 10. Demo and journeys

- [x] Seed: the feature **on** for Ada's board, a grant on the Producer tier, and a redeem already
      spent — so the mechanic differs visibly from its absence. Measure before choosing the
      numbers; §6 of the grouping spec was wrong for guessing instead
- [x] e2e: Cal redeems an accepted entry, it leads the Accepted column, Ada plays it, the marker
      clears
- [x] Walkthrough section, in the file's voice, naming what a token cannot do

## Before opening the PR

- [x] Both design questions are answered (notify: yes; undo: no) — check nothing drifted from them
- [x] All five verification commands, output quoted
- [x] e2e against a rebuilt stack, with the running image confirmed to carry the change
