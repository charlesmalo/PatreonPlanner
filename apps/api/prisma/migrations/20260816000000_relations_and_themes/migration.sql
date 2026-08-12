-- CreateEnum
CREATE TYPE "RelationKind" AS ENUM ('SEASON_OF', 'SEQUEL', 'PREQUEL', 'SAME_FRANCHISE', 'RELATED');

-- When the builder last *attempted* this title. Ordering on it stops a permanently failing title
-- from occupying the batch forever — the failure Plan 04's membership job shipped with.
ALTER TABLE "Title" ADD COLUMN "enrichedAt" TIMESTAMP(3);
CREATE INDEX "Title_enrichedAt_idx" ON "Title"("enrichedAt");

-- CreateTable
CREATE TABLE "TitleRelation" (
    "id" UUID NOT NULL,
    "fromId" UUID NOT NULL,
    "toId" UUID NOT NULL,
    "kind" "RelationKind" NOT NULL,
    "ordinal" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TitleRelation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Theme" (
    "id" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sourceKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Theme_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TitleTheme" (
    "titleId" UUID NOT NULL,
    "themeId" UUID NOT NULL,

    CONSTRAINT "TitleTheme_pkey" PRIMARY KEY ("titleId","themeId")
);

-- Idempotent by construction: re-running the builder cannot multiply rows.
CREATE UNIQUE INDEX "TitleRelation_fromId_toId_kind_key" ON "TitleRelation"("fromId", "toId", "kind");
CREATE INDEX "TitleRelation_fromId_idx" ON "TitleRelation"("fromId");
CREATE INDEX "TitleRelation_toId_idx" ON "TitleRelation"("toId");

CREATE UNIQUE INDEX "Theme_creatorId_slug_key" ON "Theme"("creatorId", "slug");
-- Re-seeding matches the TMDB label, not the display name, so a rename survives it.
CREATE UNIQUE INDEX "Theme_creatorId_sourceKey_key" ON "Theme"("creatorId", "sourceKey");
CREATE INDEX "Theme_creatorId_idx" ON "Theme"("creatorId");
CREATE INDEX "TitleTheme_themeId_idx" ON "TitleTheme"("themeId");

-- A title is not related to itself: TMDB's similar list can include the subject, and a
-- self-relation would nest a board entry under itself.
ALTER TABLE "TitleRelation" ADD CONSTRAINT "TitleRelation_no_self" CHECK ("fromId" <> "toId");

-- AddForeignKey
ALTER TABLE "TitleRelation" ADD CONSTRAINT "TitleRelation_fromId_fkey"
  FOREIGN KEY ("fromId") REFERENCES "Title"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TitleRelation" ADD CONSTRAINT "TitleRelation_toId_fkey"
  FOREIGN KEY ("toId") REFERENCES "Title"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Theme" ADD CONSTRAINT "Theme_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TitleTheme" ADD CONSTRAINT "TitleTheme_titleId_fkey"
  FOREIGN KEY ("titleId") REFERENCES "Title"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TitleTheme" ADD CONSTRAINT "TitleTheme_themeId_fkey"
  FOREIGN KEY ("themeId") REFERENCES "Theme"("id") ON DELETE CASCADE ON UPDATE CASCADE;
