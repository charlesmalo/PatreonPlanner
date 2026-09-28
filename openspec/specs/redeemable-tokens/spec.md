# redeemable-tokens Specification

## Purpose
Lets a creator give their higher tiers, and anyone they choose to thank, a countable number of
tokens that can be spent to mark an already-accepted entry as Priority — turning tier membership
into something a patron can point at rather than only influence over an average.

## Requirements

### Requirement: A board has redeemable tokens only if its creator turns them on

Redeemable tokens SHALL be off for every board until that board's creator enables them. While
disabled, no reader SHALL see any token control, balance, Priority marker or redeem count, and the
Accepted column SHALL order exactly as it does for a board that has never had the feature.

Disabling an enabled board SHALL NOT destroy balances, ledger rows or redeems. They SHALL become
invisible and unspendable, and SHALL reappear unchanged if the creator enables it again.

#### Scenario: A board that has never enabled tokens

- **WHEN** any reader loads a board whose creator has not enabled redeemable tokens
- **THEN** no Priority marker, redeem count, balance or spend control appears anywhere
- **AND** the Accepted column is ordered as it would be with the feature absent

#### Scenario: Turning it off again does not destroy what was spent

- **WHEN** a creator disables redeemable tokens on a board that has redeems on it
- **THEN** every balance, ledger row and redeem is retained
- **AND** re-enabling restores the same balances, counts and Priority markers

### Requirement: Tokens are granted per tier per period

A creator SHALL be able to set, for each of their tiers, a number of tokens granted per billing
period. Every tier SHALL start at zero, so enabling the feature grants nothing until the creator
sets a number.

A reader SHALL be granted a tier's tokens for a period only while holding an active membership at
that tier. Exactly one grant SHALL be recorded per reader per tier per period, however many times
the grant is attempted — a repeated sync, a retried job or a membership refreshed twice SHALL NOT
multiply a reader's tokens.

A reader holding memberships at more than one tier of the same creator SHALL be granted the
largest single tier's tokens, not the sum.

#### Scenario: Enabling grants nothing by itself

- **WHEN** a creator enables redeemable tokens and sets no per-tier number
- **THEN** every reader's balance on that board is zero

#### Scenario: The same period is never granted twice

- **WHEN** a grant for a reader, tier and period is attempted more than once
- **THEN** the reader's balance reflects exactly one grant
- **AND** the ledger holds exactly one grant row for that reader, tier and period

#### Scenario: A lapsed patron is granted nothing further

- **WHEN** a reader's membership at a granting tier is no longer active at the start of a period
- **THEN** no grant is recorded for that reader for that period
- **AND** tokens granted in earlier periods remain in their balance

### Requirement: A creator may grant tokens directly

A creator SHALL be able to grant tokens to a named reader on their own board, in any whole number
greater than zero, with a reason recorded. The recipient NEED NOT hold any membership — a
moderator who pays nothing SHALL be a valid recipient.

A direct grant SHALL be recorded in the ledger as a distinct kind from a tier grant, so that a
balance can always be explained.

Only a creator SHALL grant tokens. A moderator, whatever permissions they hold, SHALL NOT — a
permission to moderate content is not a permission to mint something that obliges the creator.

#### Scenario: Thanking a moderator who is not a patron

- **WHEN** a creator grants tokens to a moderator holding no membership
- **THEN** the grant succeeds and the moderator's balance increases by that amount

#### Scenario: A moderator cannot grant tokens

- **WHEN** a reader who is not the creator attempts to grant tokens on that board
- **THEN** the request is refused
- **AND** no balance changes

### Requirement: A token is spent on an accepted entry

A reader with a balance of at least one SHALL be able to spend exactly one token on an entry whose
status is `ACCEPTED`, together with a note of at most 200 characters naming what they want played.

Spending SHALL be refused for an entry in any other status. An entry that has not passed
moderation SHALL NOT be redeemable, so that a token cannot skip the queue.

A spend SHALL decrement the balance and record a ledger row atomically. A reader whose balance is
zero SHALL be refused, and concurrent spends SHALL NOT take a balance below zero.

A reader SHALL be able to spend more than one token on the same entry, one at a time, each
carrying its own note.

#### Scenario: Spending on an entry still awaiting moderation

- **WHEN** a reader with tokens attempts to spend one on a `PENDING` entry
- **THEN** the request is refused and no token is deducted

#### Scenario: A balance cannot go negative

- **WHEN** a reader holding one token spends on two entries at the same moment
- **THEN** exactly one spend succeeds and the other is refused
- **AND** the reader's balance is zero

#### Scenario: The note travels with the redeem

- **WHEN** a reader spends a token with the note `S2E04 — Jupiter Jazz pt.1`
- **THEN** that note is shown with the redeem to the creator and to staff

### Requirement: A redeemed entry is marked Priority and leads its column

An `ACCEPTED` entry with at least one unconsumed redeem SHALL show a Priority marker and the count
of unconsumed redeems on it. Redeems SHALL stack: three readers redeeming one entry SHALL show a
count of three.

On a board with the feature enabled, the Accepted column SHALL order entries with unconsumed
redeems ahead of those without, before any other ordering it applies. Priority SHALL NOT be a
status, a column, or a step in the lifecycle — an entry's status SHALL remain `ACCEPTED`, and every
existing transition SHALL remain available and unchanged.

#### Scenario: Two readers redeem the same entry

- **WHEN** two readers each spend a token on one accepted entry
- **THEN** that entry shows a redeem count of two

#### Scenario: Priority does not alter the lifecycle

- **WHEN** an entry carrying redeems is moved between statuses by staff
- **THEN** every transition available to an unredeemed entry is available to it
- **AND** its status is recorded exactly as it would be without redeems

### Requirement: A redeem is consumed when the creator plays it

When an entry carrying unconsumed redeems moves to `ACTIVE`, every unconsumed redeem on that entry
SHALL be marked consumed, and the entry SHALL stop showing the Priority marker and count.

A consumed redeem SHALL NOT be returned to the spender's balance and SHALL remain in the ledger.

Moving an entry to any status other than `ACTIVE` SHALL NOT consume its redeems. An entry moved
back from `REJECTED` to `ACCEPTED` SHALL show its unconsumed redeems again.

#### Scenario: Playing a redeemed entry

- **WHEN** staff move an entry with two unconsumed redeems to `ACTIVE`
- **THEN** both redeems are marked consumed
- **AND** the entry no longer shows a Priority marker

#### Scenario: Rejecting does not consume

- **WHEN** staff move a redeemed entry to `REJECTED` and later back to `ACCEPTED`
- **THEN** its redeems are still unconsumed and its Priority marker returns

### Requirement: A redeemer is told when their redeem is played

When an entry carrying unconsumed redeems moves to `ACTIVE`, each reader who redeemed it SHALL be
notified that the entry they redeemed is now playing. The notification SHALL be sent whether or
not that reader follows the board.

A reader SHALL receive exactly one such notification per entry per move, however many tokens they
spent on it, and SHALL NOT receive a duplicate because they also follow the board.

No such notification SHALL be sent for a move to any status other than `ACTIVE`, nor for a move
that does not complete.

#### Scenario: A redeemer who does not follow the board

- **WHEN** an entry redeemed by a reader who does not follow the board moves to `ACTIVE`
- **THEN** that reader is notified that their redeem is playing

#### Scenario: A redeemer who also follows the board

- **WHEN** an entry redeemed by a follower moves to `ACTIVE`
- **THEN** that reader receives one notification about it, not two

#### Scenario: Two tokens, one notification

- **WHEN** a reader who spent two tokens on one entry sees it move to `ACTIVE`
- **THEN** they are notified once

### Requirement: A spend is final

A reader SHALL NOT be able to reverse a spend. Once a token is spent, the balance SHALL NOT be
restored by any reader-initiated action, whether or not the redeem has been consumed.

A creator MAY grant a token to a reader who spent one by mistake, using the ordinary grant. That
grant SHALL be recorded as a grant, not as a reversal — the original spend SHALL remain in the
ledger.

#### Scenario: A reader attempting to take a spend back

- **WHEN** a reader attempts to reverse their own spend on an unconsumed redeem
- **THEN** the request is refused and their balance is unchanged

#### Scenario: A creator making good on a misspend

- **WHEN** a creator grants a token to a reader who misspent one
- **THEN** the balance increases by one
- **AND** the ledger shows both the original spend and the new grant

### Requirement: A balance is private; a redeem is not

A reader SHALL be able to see their own balance on a board and the ledger rows explaining it. A
reader SHALL NOT be able to see another reader's balance or ledger, and a request for one SHALL be
refused as though the reader did not exist.

The creator and staff who may moderate the board SHALL see who redeemed an entry and the note they
left, because the note is an instruction the creator has to act on.

Whether a redeemer is named to other readers SHALL follow the board's existing rule for naming a
submitter.

#### Scenario: One reader asking for another's balance

- **WHEN** a reader requests another reader's token balance on a board
- **THEN** the request is refused without confirming whether that reader has any tokens

#### Scenario: Staff read the note

- **WHEN** a moderator who may moderate the board opens a redeemed entry
- **THEN** they see each redeem's note and who left it
