-- Additive only: no DROP COLUMN, no SET NOT NULL on an existing column, so this is safe for a
-- rolling deploy and needs no exemption in migration-safety.e2e-spec.ts.

-- How many events one row stands for. Existing rows stand for exactly themselves.
ALTER TABLE "Notification" ADD COLUMN "groupCount" INTEGER NOT NULL DEFAULT 1;

-- Serves the coalescing lookup — everyone on this board with one of these still unread. Without
-- it, that read is a sequential scan on every move of every entry on every board.
CREATE INDEX "Notification_creatorId_type_readAt_idx" ON "Notification"("creatorId", "type", "readAt");
