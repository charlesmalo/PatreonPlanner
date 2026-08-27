-- Additive only: no DROP COLUMN, no SET NOT NULL, so this is safe for a rolling deploy and needs
-- no exemption in migration-safety.e2e-spec.ts.

-- Something moved on a board you follow. Distinct from ENTRY_STATUS_CHANGED ("your entry moved")
-- so the submitter never receives both for one move.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ENTRY_MOVED';

-- Amendment A.2: premium buys granularity, never notification itself. Unset — nothing writes this
-- until billing exists, so today every reader gets the default and nobody loses anything later.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "premiumUntil" TIMESTAMP(3);

-- An absent row means the default; an empty "statuses" means silence. Distinguishable on purpose.
CREATE TABLE "BoardNotificationPreference" (
    "userId" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "statuses" "RecommendationStatus"[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardNotificationPreference_pkey" PRIMARY KEY ("userId","creatorId")
);

ALTER TABLE "BoardNotificationPreference" ADD CONSTRAINT "BoardNotificationPreference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BoardNotificationPreference" ADD CONSTRAINT "BoardNotificationPreference_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The fan-out reads by board, and a preference outlives nothing it is not scoped to.
CREATE INDEX "BoardNotificationPreference_creatorId_idx" ON "BoardNotificationPreference"("creatorId");
