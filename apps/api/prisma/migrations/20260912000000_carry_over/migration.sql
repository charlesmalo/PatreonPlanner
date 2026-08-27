-- Additive only: new type, new table, two new columns with defaults. Safe for a rolling deploy,
-- so no exemption is needed in migration-safety.e2e-spec.ts.

CREATE TYPE "CarryOverOutcome" AS ENUM (
  'PENDING', 'SUBMITTED', 'ALREADY_PRESENT', 'REFUSED_BEFORE', 'NOT_ELIGIBLE', 'NOT_ACCEPTED', 'FAILED'
);

-- On by default. Opt-in would strand the feature at zero reach, and a carried-over entry is
-- labelled and reviewed like any other submission.
ALTER TABLE "CreatorPolicy" ADD COLUMN "acceptsCarryOver" BOOLEAN NOT NULL DEFAULT true;

-- So a moderator can judge carried-over entries as a class rather than one at a time.
ALTER TABLE "Recommendation" ADD COLUMN "viaCarryOver" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "CarryOverDelivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "sourceRecommendationId" UUID NOT NULL,
    "outcome" "CarryOverOutcome" NOT NULL DEFAULT 'PENDING',
    "resultRecommendationId" UUID,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "CarryOverDelivery_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CarryOverDelivery" ADD CONSTRAINT "CarryOverDelivery_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CarryOverDelivery" ADD CONSTRAINT "CarryOverDelivery_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cascades: what is being carried is the source entry, so if it goes there is nothing to deliver.
ALTER TABLE "CarryOverDelivery" ADD CONSTRAINT "CarryOverDelivery_sourceRecommendationId_fkey"
    FOREIGN KEY ("sourceRecommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Re-broadcasting a list is idempotent rather than additive.
CREATE UNIQUE INDEX "CarryOverDelivery_userId_creatorId_sourceRecommendationId_key"
    ON "CarryOverDelivery"("userId", "creatorId", "sourceRecommendationId");
-- The drain reads the oldest waiting deliveries first.
CREATE INDEX "CarryOverDelivery_outcome_createdAt_idx" ON "CarryOverDelivery"("outcome", "createdAt");
