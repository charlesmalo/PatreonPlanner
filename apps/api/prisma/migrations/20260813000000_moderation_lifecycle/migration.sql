-- CreateEnum
CREATE TYPE "FlagStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');
CREATE TYPE "FlagReason" AS ENUM ('SPAM', 'HARASSMENT', 'SEXUAL_CONTENT', 'OFF_TOPIC', 'DUPLICATE', 'OTHER');
CREATE TYPE "ModerationActionType" AS ENUM ('EDIT', 'DELETE', 'RESTORE', 'STATUS_CHANGE', 'FLAG_RESOLVED', 'FLAG_DISMISSED');

-- CreateTable
CREATE TABLE "Flag" (
    "id" UUID NOT NULL,
    "recommendationId" UUID NOT NULL,
    "flaggedByUserId" UUID NOT NULL,
    "reason" "FlagReason" NOT NULL,
    "note" TEXT,
    "status" "FlagStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedByUserId" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Flag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ModerationAction" (
    "id" UUID NOT NULL,
    "recommendationId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "action" "ModerationActionType" NOT NULL,
    "note" TEXT,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationAction_pkey" PRIMARY KEY ("id")
);

-- One flag per person per entry: flag count is a moderation priority signal (design §6.6), and
-- without this it measures one user's persistence rather than several users' agreement.
CREATE UNIQUE INDEX "Flag_recommendationId_flaggedByUserId_key"
  ON "Flag"("recommendationId", "flaggedByUserId");
CREATE INDEX "Flag_recommendationId_idx" ON "Flag"("recommendationId");
CREATE INDEX "Flag_flaggedByUserId_idx" ON "Flag"("flaggedByUserId");
CREATE INDEX "Flag_resolvedByUserId_idx" ON "Flag"("resolvedByUserId");

CREATE INDEX "ModerationAction_recommendationId_createdAt_idx"
  ON "ModerationAction"("recommendationId", "createdAt" DESC);
CREATE INDEX "ModerationAction_actorUserId_idx" ON "ModerationAction"("actorUserId");

-- AddForeignKey
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_recommendationId_fkey"
  FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_flaggedByUserId_fkey"
  FOREIGN KEY ("flaggedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_resolvedByUserId_fkey"
  FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_recommendationId_fkey"
  FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Restrict, not Cascade: deleting a moderator's account must not erase the record of what they
-- did. This is the one relation in the schema where the audit outlives the user.
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Serves the review queue: staff read one creator's entries oldest-first, including the statuses
-- the board index's consumers never ask for.
CREATE INDEX "Recommendation_creatorId_createdAt_idx"
  ON "Recommendation"("creatorId", "createdAt" ASC);

-- Open flags drive the queue's ordering and are a small fraction of all flags once a board has
-- been moderated for a while.
CREATE INDEX "Flag_open_idx" ON "Flag"("recommendationId") WHERE "status" = 'OPEN';
