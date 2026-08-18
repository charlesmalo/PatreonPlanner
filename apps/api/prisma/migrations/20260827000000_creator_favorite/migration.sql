CREATE TABLE "CreatorFavorite" (
    "userId" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreatorFavorite_pkey" PRIMARY KEY ("userId", "creatorId")
);

ALTER TABLE "CreatorFavorite" ADD CONSTRAINT "CreatorFavorite_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorFavorite" ADD CONSTRAINT "CreatorFavorite_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The primary key covers lookups by reader; this covers the cascade from Creator.
CREATE INDEX "CreatorFavorite_creatorId_idx" ON "CreatorFavorite"("creatorId");

-- Discovery matches on name and slug. Trigram rather than a plain prefix so a partial or slightly
-- wrong word still finds a board, reusing the extension the entry search already installed.
CREATE INDEX "Creator_displayName_trgm_idx" ON "Creator" USING GIN ("displayName" gin_trgm_ops);
