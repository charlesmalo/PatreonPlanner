-- CreateEnum
CREATE TYPE "RecommendationType" AS ENUM ('MOVIE', 'SHOW', 'FRANCHISE', 'WATCH_ORDER', 'EXTERNAL_LINK');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'ACTIVE', 'COMPLETED', 'REJECTED', 'DELETED');

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "submittedByUserId" UUID NOT NULL,
    "type" "RecommendationType" NOT NULL,
    "customTitle" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "description" TEXT,
    "notes" TEXT,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'PENDING',
    "upvoteCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationLink" (
    "id" UUID NOT NULL,
    "recommendationId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Upvote" (
    "id" UUID NOT NULL,
    "recommendationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Upvote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Recommendation_creatorId_status_upvoteCount_idx" ON "Recommendation"("creatorId", "status", "upvoteCount");

-- CreateIndex
CREATE INDEX "Recommendation_creatorId_normalizedTitle_idx" ON "Recommendation"("creatorId", "normalizedTitle");

-- CreateIndex
CREATE INDEX "Recommendation_submittedByUserId_idx" ON "Recommendation"("submittedByUserId");

-- CreateIndex
CREATE INDEX "RecommendationLink_recommendationId_idx" ON "RecommendationLink"("recommendationId");

-- CreateIndex
CREATE INDEX "Upvote_userId_idx" ON "Upvote"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Upvote_recommendationId_userId_key" ON "Upvote"("recommendationId", "userId");

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationLink" ADD CONSTRAINT "RecommendationLink_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upvote" ADD CONSTRAINT "Upvote_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upvote" ADD CONSTRAINT "Upvote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
