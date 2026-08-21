ALTER TABLE "Tier" ADD COLUMN "voteWeight" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Upvote" ADD COLUMN "tierId" UUID;
ALTER TABLE "Recommendation" ADD COLUMN "weightedScore" INTEGER NOT NULL DEFAULT 0;

-- Every vote cast so far was worth one, and every tier starts worth one, so the score begins as
-- the headcount. A board that never touches weights ranks exactly as it did before.
UPDATE "Recommendation" SET "weightedScore" = "upvoteCount";

-- Restrict, not SetNull: a tier with votes against it must not be deletable, since dropping the
-- reference would silently reprice every vote cast at it.
ALTER TABLE "Upvote" ADD CONSTRAINT "Upvote_tierId_fkey"
    FOREIGN KEY ("tierId") REFERENCES "Tier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A rebalance recomputes from these, grouped by tier.
CREATE INDEX "Upvote_tierId_idx" ON "Upvote"("tierId");

-- The board's ordering leads with picks, then the weighted score.
DROP INDEX IF EXISTS "Recommendation_board_order_idx";
CREATE INDEX "Recommendation_board_order_idx"
    ON "Recommendation"("creatorId", "isCreatorPick" DESC, "weightedScore" DESC, "createdAt" DESC, "id" DESC);
