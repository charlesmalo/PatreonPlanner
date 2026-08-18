-- Ranked at write time rather than derived from the payload on every sort. Existing rows keep 0,
-- which is the right answer for a status change and a conservative one for an old report: it
-- sinks rather than jumping the queue on a severity nobody assigned it.
ALTER TABLE "Notification" ADD COLUMN "severity" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Notification_userId_severity_createdAt_id_idx"
    ON "Notification"("userId", "severity" DESC, "createdAt" DESC, "id" DESC);
