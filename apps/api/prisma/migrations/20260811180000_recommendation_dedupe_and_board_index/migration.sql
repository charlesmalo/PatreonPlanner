-- The old index led with `status`, which sits between the equality column and the sort columns
-- and is used with an inequality, so Postgres could not walk it in sort order — every board page
-- sorted the creator's entire table.
DROP INDEX "Recommendation_creatorId_status_upvoteCount_idx";

-- Matches the board's ORDER BY exactly.
CREATE INDEX "Recommendation_board_idx"
  ON "Recommendation"("creatorId", "upvoteCount" DESC, "createdAt" DESC, "id" DESC);

-- De-duplication is enforced here, not by the read-then-write check in the service: two
-- concurrent submissions of the same title both miss that read.
DROP INDEX "Recommendation_creatorId_normalizedTitle_idx";
CREATE UNIQUE INDEX "Recommendation_creatorId_normalizedTitle_key"
  ON "Recommendation"("creatorId", "normalizedTitle");

-- A tripwire rather than a fix: the counter is maintained transactionally, but a cascade delete
-- of a user removes Upvote rows without touching it, and nothing should ever drive it negative.
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_upvoteCount_non_negative"
  CHECK ("upvoteCount" >= 0);
