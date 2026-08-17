CREATE TYPE "ModerationSubjectType" AS ENUM ('RECOMMENDATION', 'NOTE', 'THEME', 'FLAG_NOTE');

-- Design §6.5: the pipeline's verdicts, kept. Only FLAG and BLOCK are written; PASS is the
-- absence of a row. The reviewed text is deliberately not stored — see the schema comment.
CREATE TABLE "ModerationResult" (
    "id" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "subjectType" "ModerationSubjectType" NOT NULL,
    -- Null when the content was rejected outright and therefore never created.
    "subjectId" UUID,
    "verdict" TEXT NOT NULL,
    "categories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationResult_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ModerationResult" ADD CONSTRAINT "ModerationResult_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModerationResult" ADD CONSTRAINT "ModerationResult_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ModerationResult_creatorId_createdAt_idx"
    ON "ModerationResult"("creatorId", "createdAt" DESC);
-- The review queue looks up the verdict for the entries on the page it is showing.
CREATE INDEX "ModerationResult_subjectId_idx" ON "ModerationResult"("subjectId");
