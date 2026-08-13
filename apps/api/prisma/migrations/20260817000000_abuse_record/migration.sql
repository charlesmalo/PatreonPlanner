-- CreateEnum
CREATE TYPE "StrikeReason" AS ENUM ('RATE_LIMIT', 'MODERATION_BLOCK', 'UPHELD_FLAG', 'DUPLICATE_FLOOD');

-- CreateTable
CREATE TABLE "AbuseRecord" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "strikeCount" INTEGER NOT NULL DEFAULT 0,
    "timeoutUntil" TIMESTAMP(3),
    "lastStrikeAt" TIMESTAMP(3),
    "lastReason" "StrikeReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AbuseRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AbuseRecord_userId_key" ON "AbuseRecord"("userId");
-- The decay job walks the quietest first.
CREATE INDEX "AbuseRecord_lastStrikeAt_idx" ON "AbuseRecord"("lastStrikeAt");
CREATE INDEX "AbuseRecord_timeoutUntil_idx" ON "AbuseRecord"("timeoutUntil");

-- A negative count would invert the penalty curve.
ALTER TABLE "AbuseRecord" ADD CONSTRAINT "AbuseRecord_strikes_non_negative"
  CHECK ("strikeCount" >= 0);

-- AddForeignKey
ALTER TABLE "AbuseRecord" ADD CONSTRAINT "AbuseRecord_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
