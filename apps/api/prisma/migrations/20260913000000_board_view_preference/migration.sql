-- Additive only: one new table. Safe for a rolling deploy, no exemption needed.

-- How one reader has arranged one board for themselves. `sorts` is jsonb rather than a column per
-- status, because the set of columns is the lifecycle enum and a column each would need a
-- migration every time that grows.
CREATE TABLE "BoardViewPreference" (
    "userId" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "collapsed" "RecommendationStatus"[],
    "sorts" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardViewPreference_pkey" PRIMARY KEY ("userId","creatorId")
);

ALTER TABLE "BoardViewPreference" ADD CONSTRAINT "BoardViewPreference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BoardViewPreference" ADD CONSTRAINT "BoardViewPreference_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "BoardViewPreference_creatorId_idx" ON "BoardViewPreference"("creatorId");
