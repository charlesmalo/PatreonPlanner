-- Redeemable priority tokens.
--
-- A creator may give their tiers a countable number of tokens per period. A patron spends one to
-- mark an already-accepted entry as Priority, with a note naming what they want played. Redeems
-- stack, lead the Accepted column, and are consumed when the entry starts playing.
--
-- Additive only, and off everywhere: every existing board reads `redeemTokensEnabled = false` and
-- every tier reads zero, which is the state each has had since it was created. There is nothing
-- to backfill.

-- The opt-in. Off by default, so a board that never hears of this feature behaves exactly as it
-- did before the feature existed.
ALTER TABLE "CreatorPolicy" ADD COLUMN "redeemTokensEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Zero by default, so enabling the feature grants nothing until the creator says who gets what.
ALTER TABLE "Tier" ADD COLUMN "tokensPerPeriod" INTEGER NOT NULL DEFAULT 0;

-- Stored rather than counted on read, for the reason `weightedScore` is stored: the board orders
-- on this column and pages by keyset, and ordering by an aggregate over a joined table makes the
-- cursor meaningless.
ALTER TABLE "Recommendation" ADD COLUMN "unconsumedRedeems" INTEGER NOT NULL DEFAULT 0;

-- Distinct from ENTRY_MOVED for the same reason ENTRY_MOVED is distinct from
-- ENTRY_STATUS_CHANGED: a redeemer who also follows the board must receive one notification for
-- the move, not two.
ALTER TYPE "NotificationType" ADD VALUE 'REDEEM_PLAYING';

CREATE TYPE "TokenLedgerKind" AS ENUM ('TIER_GRANT', 'CREATOR_GRANT', 'SPEND');

-- What a reader has left to spend on one creator's board. A cache of the ledger's sum, written in
-- the same transaction as the ledger row that moves it.
CREATE TABLE "TokenBalance" (
    "id" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "available" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TokenBalance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TokenBalance_creatorId_userId_key" ON "TokenBalance"("creatorId", "userId");

-- Every movement of a token, so a balance can always be explained. When a patron says "I had
-- three", the answer has to be rows.
CREATE TABLE "TokenLedger" (
    "id" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "TokenLedgerKind" NOT NULL,
    -- Positive for a grant, negative for a spend, so the column sums to the balance.
    "amount" INTEGER NOT NULL,
    "tierId" UUID,
    "periodKey" TEXT,
    "reason" TEXT,
    "redeemId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TokenLedger_pkey" PRIMARY KEY ("id")
);

-- One token spent on one entry. The note is free text rather than a catalogue reference: nothing
-- here models an episode, so "S2E04" is a sentence the creator reads rather than a row resolved.
CREATE TABLE "Redeem" (
    "id" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "recommendationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "note" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Redeem_pkey" PRIMARY KEY ("id")
);

-- The idempotency guarantee, in the database rather than in a service that has to remember to
-- check. Membership sync runs on webhooks, on a refresh job and on sign-in, and is transactional
-- with none of them — a grant that is merely *usually* run once will one day run twice.
--
-- Keyed on the period and NOT the tier. Including the tier lets a reader who upgrades mid-period
-- be granted a second time, because the new tier makes a new key — measured at 1 + 3 = 4 tokens
-- for one month, which is a patron upgrading and downgrading to mint them.
--
-- Postgres treats NULLs as distinct in a unique index, so this constrains TIER_GRANT rows only:
-- a CREATOR_GRANT has no period, and several are expected.
CREATE UNIQUE INDEX "TokenLedger_creatorId_userId_periodKey_key"
    ON "TokenLedger"("creatorId", "userId", "periodKey");

CREATE INDEX "TokenLedger_creatorId_userId_createdAt_idx"
    ON "TokenLedger"("creatorId", "userId", "createdAt");

-- The board counts unconsumed redeems per entry on every load.
CREATE INDEX "Redeem_recommendationId_consumedAt_idx" ON "Redeem"("recommendationId", "consumedAt");
CREATE INDEX "Redeem_creatorId_userId_idx" ON "Redeem"("creatorId", "userId");

ALTER TABLE "TokenBalance" ADD CONSTRAINT "TokenBalance_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TokenBalance" ADD CONSTRAINT "TokenBalance_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TokenLedger" ADD CONSTRAINT "TokenLedger_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TokenLedger" ADD CONSTRAINT "TokenLedger_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SetNull, not Cascade: deleting a tier must not erase the record of tokens it once granted.
ALTER TABLE "TokenLedger" ADD CONSTRAINT "TokenLedger_tierId_fkey"
    FOREIGN KEY ("tierId") REFERENCES "Tier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TokenLedger" ADD CONSTRAINT "TokenLedger_redeemId_fkey"
    FOREIGN KEY ("redeemId") REFERENCES "Redeem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Redeem" ADD CONSTRAINT "Redeem_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Redeem" ADD CONSTRAINT "Redeem_recommendationId_fkey"
    FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Redeem" ADD CONSTRAINT "Redeem_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
