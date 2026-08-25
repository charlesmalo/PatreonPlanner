CREATE TYPE "LinkStatus" AS ENUM ('CANDIDATE', 'PUBLISHED');

ALTER TABLE "RecommendationLink" ADD COLUMN "status" "LinkStatus" NOT NULL DEFAULT 'CANDIDATE';
ALTER TABLE "RecommendationLink" ADD COLUMN "canonicalUrl" TEXT;
ALTER TABLE "RecommendationLink" ADD COLUMN "submittedByUserId" UUID;
ALTER TABLE "RecommendationLink" ADD COLUMN "isPreferred" BOOLEAN NOT NULL DEFAULT false;

-- Existing links are what the board already shows. Hiding them would be a regression dressed as
-- a fix: this rule governs what arrives from now on, not what a creator has already accepted.
UPDATE "RecommendationLink" SET "status" = 'PUBLISHED';

-- Seeded from the URL itself. Canonicalisation only ever removes the parts that say *where* a
-- page was found, so an unprocessed value is its own identity and stays distinct.
UPDATE "RecommendationLink" SET "canonicalUrl" = "url" WHERE "canonicalUrl" IS NULL;

-- Two rows that were distinct URLs may share a canonical form. Keep the oldest of each, which is
-- the one a creator has had longest.
--
-- Ordered on ("createdAt", "id") rather than "createdAt" alone. Links submitted with one entry
-- were written by a single statement, so they share a timestamp to the microsecond — and a strict
-- `>` on equal values deletes neither row, leaving the duplicate in place for CREATE UNIQUE INDEX
-- below to fail on. Verified against Postgres 16 before this comment was written: the naive form
-- reported two survivors and then errored with "could not create unique index".
DELETE FROM "RecommendationLink" a
 USING "RecommendationLink" b
 WHERE a."recommendationId" = b."recommendationId"
   AND a."canonicalUrl" = b."canonicalUrl"
   AND (a."createdAt", a."id") > (b."createdAt", b."id");

ALTER TABLE "RecommendationLink" ALTER COLUMN "canonicalUrl" SET NOT NULL;

ALTER TABLE "RecommendationLink" ADD CONSTRAINT "RecommendationLink_submittedByUserId_fkey"
    FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "RecommendationLink_recommendationId_canonicalUrl_key"
    ON "RecommendationLink"("recommendationId", "canonicalUrl");
CREATE INDEX "RecommendationLink_submittedByUserId_idx" ON "RecommendationLink"("submittedByUserId");
