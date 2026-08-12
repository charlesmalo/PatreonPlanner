-- CreateEnum
-- Declared for the schema's sake; offers are stored as JSON, so the kind travels inside them.
CREATE TYPE "OfferKind" AS ENUM ('FLATRATE', 'FREE', 'ADS', 'RENT', 'BUY');

-- CreateTable
CREATE TABLE "StreamingAvailability" (
    "id" UUID NOT NULL,
    "titleId" UUID NOT NULL,
    "region" VARCHAR(2) NOT NULL,
    "link" TEXT,
    "offers" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StreamingAvailability_pkey" PRIMARY KEY ("id")
);

-- One row per title per region: a row that flattened TMDB's country map would answer the wrong
-- question for every patron outside whichever region it happened to be fetched for.
CREATE UNIQUE INDEX "StreamingAvailability_titleId_region_key"
  ON "StreamingAvailability"("titleId", "region");

-- The refresh job walks the oldest first, across every title and region.
CREATE INDEX "StreamingAvailability_fetchedAt_idx" ON "StreamingAvailability"("fetchedAt");

-- AddForeignKey
ALTER TABLE "StreamingAvailability" ADD CONSTRAINT "StreamingAvailability_titleId_fkey"
  FOREIGN KEY ("titleId") REFERENCES "Title"("id") ON DELETE CASCADE ON UPDATE CASCADE;
