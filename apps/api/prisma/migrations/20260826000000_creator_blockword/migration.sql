CREATE TYPE "BlockwordAction" AS ENUM ('BLOCK', 'FLAG');

-- Design §6.5(a): the per-creator half of the wordlist stage.
CREATE TABLE "CreatorBlockword" (
    "id" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    -- Normalised on write, so matching never has to care how it was typed.
    "pattern" TEXT NOT NULL,
    "action" "BlockwordAction" NOT NULL DEFAULT 'BLOCK',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreatorBlockword_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CreatorBlockword" ADD CONSTRAINT "CreatorBlockword_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Also the index the moderator reads by, since the list is always fetched a whole board at a time.
CREATE UNIQUE INDEX "CreatorBlockword_creatorId_pattern_key"
    ON "CreatorBlockword"("creatorId", "pattern");
