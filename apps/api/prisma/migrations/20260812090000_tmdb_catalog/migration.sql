-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('MOVIE', 'TV');
CREATE TYPE "AliasKind" AS ENUM ('OFFICIAL', 'ROMAJI', 'NATIVE', 'ALTERNATIVE');

-- CreateTable
CREATE TABLE "Title" (
    "id" UUID NOT NULL,
    "tmdbId" INTEGER NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER,
    "posterPath" TEXT,
    "overview" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Title_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TitleAlias" (
    "id" UUID NOT NULL,
    "titleId" UUID NOT NULL,
    "language" TEXT NOT NULL,
    "kind" "AliasKind" NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TitleAlias_pkey" PRIMARY KEY ("id")
);

-- TMDB ids are only unique within a media type: film 123 and series 123 are different works.
CREATE UNIQUE INDEX "Title_tmdbId_mediaType_key" ON "Title"("tmdbId", "mediaType");
CREATE UNIQUE INDEX "TitleAlias_titleId_language_kind_text_key"
  ON "TitleAlias"("titleId", "language", "kind", "text");
CREATE INDEX "TitleAlias_titleId_idx" ON "TitleAlias"("titleId");

ALTER TABLE "TitleAlias" ADD CONSTRAINT "TitleAlias_titleId_fkey"
  FOREIGN KEY ("titleId") REFERENCES "Title"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Recommendation" ADD COLUMN "titleId" UUID;
CREATE INDEX "Recommendation_titleId_idx" ON "Recommendation"("titleId");
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_titleId_fkey"
  FOREIGN KEY ("titleId") REFERENCES "Title"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- De-duplication moves to two partial indexes, which Prisma cannot express.
DROP INDEX "Recommendation_creatorId_normalizedTitle_key";

-- Canonical, per design §5. Only applies to TMDB-bound rows.
CREATE UNIQUE INDEX "Recommendation_creatorId_titleId_type_key"
  ON "Recommendation"("creatorId", "titleId", "type")
  WHERE "titleId" IS NOT NULL AND "status" <> 'DELETED';

-- External links have no canonical id, so they keep de-duplicating on the normalized title.
-- Excluding DELETED is new: the previous unconditional index blocked resubmitting anything a
-- moderator had removed, permanently.
CREATE UNIQUE INDEX "Recommendation_creatorId_normalizedTitle_key"
  ON "Recommendation"("creatorId", "normalizedTitle")
  WHERE "titleId" IS NULL AND "status" <> 'DELETED';
