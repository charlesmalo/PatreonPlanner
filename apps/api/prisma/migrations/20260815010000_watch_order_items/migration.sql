-- CreateTable
CREATE TABLE "WatchOrderItem" (
    "id" UUID NOT NULL,
    "recommendationId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "titleId" UUID,
    "customTitle" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchOrderItem_pkey" PRIMARY KEY ("id")
);

-- Positions are normalised to 0..n-1 on write; this is what makes a duplicate impossible rather
-- than merely unlikely.
CREATE UNIQUE INDEX "WatchOrderItem_recommendationId_position_key"
  ON "WatchOrderItem"("recommendationId", "position");
CREATE INDEX "WatchOrderItem_recommendationId_idx" ON "WatchOrderItem"("recommendationId");
CREATE INDEX "WatchOrderItem_titleId_idx" ON "WatchOrderItem"("titleId");

-- Exactly one of the two identities: an item with neither has nothing to render, and one with
-- both is ambiguous about which name is authoritative.
ALTER TABLE "WatchOrderItem" ADD CONSTRAINT "WatchOrderItem_one_identity"
  CHECK (("titleId" IS NULL) <> ("customTitle" IS NULL));

-- AddForeignKey
ALTER TABLE "WatchOrderItem" ADD CONSTRAINT "WatchOrderItem_recommendationId_fkey"
  FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WatchOrderItem" ADD CONSTRAINT "WatchOrderItem_titleId_fkey"
  FOREIGN KEY ("titleId") REFERENCES "Title"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
