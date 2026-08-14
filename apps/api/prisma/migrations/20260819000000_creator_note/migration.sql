-- CreateEnum
CREATE TYPE "NoteKind" AS ENUM ('NOTE', 'TIMELINE');

-- CreateTable
CREATE TABLE "CreatorNote" (
    "id" UUID NOT NULL,
    "recommendationId" UUID NOT NULL,
    "authorUserId" UUID NOT NULL,
    "kind" "NoteKind" NOT NULL,
    "body" TEXT NOT NULL,
    "plannedFor" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorNote_pkey" PRIMARY KEY ("id")
);

-- Notes read oldest-first: a timeline read backwards is not a timeline.
CREATE INDEX "CreatorNote_recommendationId_createdAt_idx"
  ON "CreatorNote"("recommendationId", "createdAt");
CREATE INDEX "CreatorNote_authorUserId_idx" ON "CreatorNote"("authorUserId");

-- A planned date on editor commentary has no meaning and nothing renders it.
ALTER TABLE "CreatorNote" ADD CONSTRAINT "CreatorNote_planned_only_on_timeline"
  CHECK ("kind" = 'TIMELINE' OR "plannedFor" IS NULL);

-- AddForeignKey
ALTER TABLE "CreatorNote" ADD CONSTRAINT "CreatorNote_recommendationId_fkey"
  FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Restrict, like ModerationAction: deleting a moderator must not erase what they wrote.
ALTER TABLE "CreatorNote" ADD CONSTRAINT "CreatorNote_authorUserId_fkey"
  FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
