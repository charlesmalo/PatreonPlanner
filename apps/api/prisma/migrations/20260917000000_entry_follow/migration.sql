-- Additive only: one new table. Safe for a rolling deploy.

-- "Tell me about this one" — the thing a genre vocabulary cannot express.
CREATE TABLE "EntryFollow" (
    "userId" UUID NOT NULL,
    "recommendationId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntryFollow_pkey" PRIMARY KEY ("userId","recommendationId")
);

ALTER TABLE "EntryFollow" ADD CONSTRAINT "EntryFollow_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Cascades: a deleted entry has nothing left to notify anybody about.
ALTER TABLE "EntryFollow" ADD CONSTRAINT "EntryFollow_recommendationId_fkey"
    FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The fan-out asks "who follows this entry" on every move.
CREATE INDEX "EntryFollow_recommendationId_idx" ON "EntryFollow"("recommendationId");
