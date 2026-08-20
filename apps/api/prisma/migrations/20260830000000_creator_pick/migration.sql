ALTER TABLE "Recommendation" ADD COLUMN "isCreatorPick" BOOLEAN NOT NULL DEFAULT false;

-- Every column ordering now leads with the pick flag, so it leads the index too.
CREATE INDEX "Recommendation_board_order_idx"
    ON "Recommendation"("creatorId", "isCreatorPick" DESC, "upvoteCount" DESC, "createdAt" DESC, "id" DESC);
