-- A theme owned exactly one TMDB label, which made merging impossible to do correctly: deleting
-- the losing theme freed its label, and the next enrichment pass re-created the theme the creator
-- had just folded away. Moving the mapping into its own table lets one theme answer to many
-- labels, which is what a merged theme is.
CREATE TABLE "ThemeSource" (
    "creatorId" UUID NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "themeId" UUID NOT NULL,

    CONSTRAINT "ThemeSource_pkey" PRIMARY KEY ("creatorId", "sourceKey")
);

-- Backfilled before the column goes away. The old unique index treated NULLs as distinct, so
-- themes a creator invented by hand carry no label and correctly get no row here.
INSERT INTO "ThemeSource" ("creatorId", "sourceKey", "themeId")
SELECT "creatorId", "sourceKey", "id" FROM "Theme" WHERE "sourceKey" IS NOT NULL;

ALTER TABLE "ThemeSource" ADD CONSTRAINT "ThemeSource_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ThemeSource" ADD CONSTRAINT "ThemeSource_themeId_fkey"
    FOREIGN KEY ("themeId") REFERENCES "Theme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The merge path rewrites every row for one theme, and the seeder never reads by theme.
CREATE INDEX "ThemeSource_themeId_idx" ON "ThemeSource"("themeId");

DROP INDEX "Theme_creatorId_sourceKey_key";
ALTER TABLE "Theme" DROP COLUMN "sourceKey";
