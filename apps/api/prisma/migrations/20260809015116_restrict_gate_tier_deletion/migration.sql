-- DropForeignKey
ALTER TABLE "CreatorPolicy" DROP CONSTRAINT "CreatorPolicy_submitMinTierId_fkey";

-- DropForeignKey
ALTER TABLE "CreatorPolicy" DROP CONSTRAINT "CreatorPolicy_upvoteMinTierId_fkey";

-- AddForeignKey
ALTER TABLE "CreatorPolicy" ADD CONSTRAINT "CreatorPolicy_submitMinTierId_fkey" FOREIGN KEY ("submitMinTierId") REFERENCES "Tier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorPolicy" ADD CONSTRAINT "CreatorPolicy_upvoteMinTierId_fkey" FOREIGN KEY ("upvoteMinTierId") REFERENCES "Tier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
