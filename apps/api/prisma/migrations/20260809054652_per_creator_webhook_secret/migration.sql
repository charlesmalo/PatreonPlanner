-- AlterTable
ALTER TABLE "Creator" ADD COLUMN     "tiersSyncedAt" TIMESTAMP(3),
ADD COLUMN     "webhookSecretEncrypted" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "membershipsRefreshedAt" TIMESTAMP(3);
