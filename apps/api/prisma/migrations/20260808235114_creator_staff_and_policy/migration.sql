-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('OWNER', 'MOD');

-- CreateEnum
CREATE TYPE "ViewVisibility" AS ENUM ('PUBLIC', 'ANY_PATREON_USER', 'SUBSCRIBERS_ONLY');

-- AlterTable
ALTER TABLE "Creator" ADD COLUMN     "baseUrl" TEXT;

-- CreateTable
CREATE TABLE "CreatorStaff" (
    "id" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "StaffRole" NOT NULL,
    "assignedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorStaff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorPolicy" (
    "id" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "viewVisibility" "ViewVisibility" NOT NULL DEFAULT 'PUBLIC',
    "submitMinTierId" UUID,
    "upvoteMinTierId" UUID,
    "hidePendingFromPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreatorStaff_creatorId_idx" ON "CreatorStaff"("creatorId");

-- CreateIndex
CREATE INDEX "CreatorStaff_userId_idx" ON "CreatorStaff"("userId");

-- CreateIndex
CREATE INDEX "CreatorStaff_assignedByUserId_idx" ON "CreatorStaff"("assignedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorStaff_creatorId_userId_key" ON "CreatorStaff"("creatorId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorPolicy_creatorId_key" ON "CreatorPolicy"("creatorId");

-- CreateIndex
CREATE INDEX "CreatorPolicy_submitMinTierId_idx" ON "CreatorPolicy"("submitMinTierId");

-- CreateIndex
CREATE INDEX "CreatorPolicy_upvoteMinTierId_idx" ON "CreatorPolicy"("upvoteMinTierId");

-- AddForeignKey
ALTER TABLE "CreatorStaff" ADD CONSTRAINT "CreatorStaff_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorStaff" ADD CONSTRAINT "CreatorStaff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorStaff" ADD CONSTRAINT "CreatorStaff_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorPolicy" ADD CONSTRAINT "CreatorPolicy_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorPolicy" ADD CONSTRAINT "CreatorPolicy_submitMinTierId_fkey" FOREIGN KEY ("submitMinTierId") REFERENCES "Tier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorPolicy" ADD CONSTRAINT "CreatorPolicy_upvoteMinTierId_fkey" FOREIGN KEY ("upvoteMinTierId") REFERENCES "Tier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
