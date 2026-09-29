## Context

See proposal.md — Why. Three facts about the code as it stands shape everything below.

**There is no Patreon billing period.** `currentPeriodEnd` exists on `Subscription`, but that is
*this product's own* premium subscription, not a reader's Patreon membership. `Membership` records
`amountCents`, `currentTierId` and `isActivePatron` — a state, never a date. So "N tokens per
payment month" has nothing to read a month boundary from, and inventing one per reader from
Patreon would need data the sync does not fetch.

**Membership sync runs repeatedly and is not transactional with anything.** Webhooks, the refresh
job and a sign-in all re-derive the same membership. Anything that grants on sync must be
idempotent by construction, not by luck.

**The board already composes its `where` with `AND: [...]`** and orders by
`isCreatorPick DESC, …`. Priority ordering has to join that list, not fight it — the comment
beside that clause records what happened the last time a clause was spread instead.

## Goals / Non-Goals

**Goals:**

- A balance that can always be explained from rows a human can read
- Granting that is safe to run twice, because it will be
- Priority ordering that composes with creator picks and the existing sorts rather than replacing
  them
- Every table and query creator-scoped, so one board's tokens can never be spent on another's

**Non-Goals:**

- Episode-level anything (proposal — *Out*)
- Reading a real Patreon billing date. The period is this product's own calendar month, in UTC —
  see the first decision
- Any relationship to the premium `Subscription`. Two unrelated things that both involve money
  are still two unrelated things

## Decisions

### A period is a UTC calendar month, stored as a string key

`periodKey` is `YYYY-MM`, computed in UTC at grant time. A unique constraint on
`(creatorId, userId, tierId, periodKey)` makes the grant idempotent in the database rather than in
a service that has to remember to check.

*Why not the reader's real Patreon renewal date:* the sync does not fetch it, Patreon charges on
different days for different patrons, and a per-reader boundary means a per-reader scheduler. A
calendar month is a day or two "wrong" for most readers and understandable by all of them.

*Why a string, not a date range:* a unique constraint over a range needs an exclusion constraint
and a migration most readers of this schema will not recognise. `2026-09` compares, sorts and reads
correctly, and the collision it must prevent is exact equality.

*Consequence, stated plainly:* a reader joining on the 28th is granted a full month's tokens for
three days. The alternative — prorating — makes a small feature arithmetic-heavy and gives a
confusing number to somebody who paid a full tier price.

### Grant lazily, on read, not from a scheduled job

The balance endpoint grants any missing period for the caller before answering. No cron, no fan-out
over every member of every board at midnight on the first.

*Why:* a monthly fan-out over every creator's membership list is the most expensive thing in this
product, runs when nobody is watching, and retries into exactly the double-grant the unique
constraint exists to stop. Lazy granting does the same work spread across the month, only for
readers who actually look, and each grant is one upsert.

*Alternative considered:* granting during membership sync. Rejected — sync runs on webhooks, which
means granting is driven by Patreon's delivery schedule rather than the calendar, and a reader
whose membership never changes would never be granted.

*Consequence:* a reader who never opens the board accrues no rows until they do, then is granted
the current period only. Back-granting every missed month would hand somebody a year of tokens for
returning, which is not a thank-you, it is a windfall.

### Balance is a stored integer, and the ledger is the truth

`TokenBalance` holds `available` per `(creatorId, userId)`. `TokenLedger` holds one row per grant
and per spend, with a kind, an amount, and the reason or the redeem it belongs to.

Reads use the balance. Every write updates both in one transaction. The balance is a cache of the
ledger's sum and a periodic check can assert they agree.

*Why not sum the ledger on read:* the board reads a balance on every load, and a growing sum per
reader per board is a scan that gets slower every month forever.

*Why keep the ledger at all:* a number nobody can explain is a number nobody can argue with. When
a patron says "I had three", the answer has to be rows.

### Spending is a conditional update, not read-then-write

```
UPDATE "TokenBalance" SET available = available - 1
WHERE "creatorId" = $1 AND "userId" = $2 AND available > 0
```

Zero rows updated means the balance was zero, and the spend is refused. The whole spend — decrement,
ledger row, redeem row — is one transaction.

*Why:* this is the same shape the moderation status change already uses (`updateMany` conditional
on the status it was checked against, refusing when `count === 0`), and for the same reason: two
requests that both read a balance of one would both pass a check and both write.

### Priority orders inside the existing sort, ahead of nothing else

The Accepted column's order becomes `isCreatorPick DESC, hasUnconsumedRedeem DESC, <existing sort>`.

*Why below creator picks:* a creator pick is the creator's own statement about their own board.
A token is a request. When they disagree, the person who owns the board wins.

*Why a denormalised `unconsumedRedeems` count on `Recommendation`, not a join:* the board pages by
keyset, and ordering by an aggregate over a joined table makes the cursor meaningless — the same
reason `weightedScore` is stored rather than computed. Maintained in the same transaction as the
spend and the consume.

### Consuming happens where the move happens

`ModerationActionsService.changeStatus` already runs a transaction that writes the status, the
audit row and the notification. Consuming redeems joins it.

*Why not a listener on the status change:* a redeem consumed outside that transaction can be
consumed for a move that rolled back — which is the argument the audit row is already written
inline for, in a comment beside it.

## Risks / Trade-offs

**A UTC month is not anybody's billing month** → Accepted and documented in the UI: the balance
says "resets 1 October". Prorating is the alternative and it is worse.

**Lazy granting means a reader who does not look is not granted** → They are granted the current
period the moment they look. Only a reader who was absent for whole months loses anything, and
back-granting is a windfall rather than a fix.

**The balance can drift from the ledger** if a future write updates one and not the other →
Both writes live in one transaction in one service. A periodic check asserting `SUM(ledger) =
balance` per reader is cheap and belongs in the tasks.

**Priority reorders a column readers have learned** → Only on boards that opt in, and Priority
entries are visibly marked. The spec requires the marker precisely so the reorder has a visible
cause; the proposal names this as the one regression-shaped change.

**A creator could grant themselves unlimited tokens** → They could. It is their board, their
tokens, and their patrons will notice. Not a technical problem.

**Two tiers, one reader** → The spec says largest tier, not sum. The unique constraint is per
tier, so a reader holding two granting tiers would get two rows without an explicit
highest-tier-only rule in the grant. The tasks must test exactly this.

## Migration Plan

Additive only. One migration adds two columns (`CreatorPolicy.redeemTokensEnabled`,
`Tier.tokensPerPeriod`, both defaulting to off/zero) and three tables. No backfill: every existing
board is off, which is the same state it has had since it was created.

Rollback is dropping the tables and columns; nothing existing reads them.

## Resolved Questions

Both were left open when this design was written, and both are now decided.

### The redeemer IS told when their redeem is played — **decided**

A distinct notification, sent to each redeemer when the entry they redeemed reaches `ACTIVE`.

The move already fans out to followers, so the machinery exists; this adds a notification type and
a second recipient list. A redeemer is not necessarily a follower, and the moment the thing they
spent on starts is the moment the token pays off. Staying silent spends the feature's whole
emotional return to save one enum value.

Consumption and notification happen in the same transaction as the status change, for the reason
the audit row already lives there: a notification telling someone their redeem is playing, when
the move was rolled back, is worse than none.

### A spend is final — **decided: no undo**

No undo window. A spend decrements, records and redeems in one transaction, and that is the end of
it.

*Why not the five-minute window considered here:* it needs a race settled between an undo and the
creator consuming the redeem mid-undo, a rule for what happens when they collide, and a test for
each. It is also inconsistent with the proposal already ruling out declines and refunds — three
ways to un-spend a token is two more than a feature this size can explain.

*What a misspend costs:* nothing that cannot be fixed by a creator granting one back, which is
already in scope and needs no new rules. A patron who redeems the wrong entry asks; the creator
decides. That is a conversation rather than a mechanism, which is the right size for a mistake
this rare.
