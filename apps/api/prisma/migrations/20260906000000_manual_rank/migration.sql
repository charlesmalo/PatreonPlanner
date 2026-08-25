-- Fractional so an insert between two cards writes one row rather than renumbering the column.
-- Null means never placed by hand, which sorts last.
ALTER TABLE "Recommendation" ADD COLUMN "manualRank" DOUBLE PRECISION;

-- NULLS LAST matches the ordering the board asks for, so an unplaced card falls to the bottom
-- rather than the top.
CREATE INDEX "Recommendation_manual_order_idx"
    ON "Recommendation"("creatorId", "isCreatorPick" DESC, "manualRank" DESC NULLS LAST, "createdAt" DESC, "id" DESC);
