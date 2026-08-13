-- CreateTable
CREATE TABLE "StaffInvite" (
    "id" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "invitedByUserId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" UUID,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffInvite_pkey" PRIMARY KEY ("id")
);

-- The hash is the lookup key: the plaintext is returned once and never stored.
CREATE UNIQUE INDEX "StaffInvite_tokenHash_key" ON "StaffInvite"("tokenHash");
CREATE INDEX "StaffInvite_creatorId_idx" ON "StaffInvite"("creatorId");
CREATE INDEX "StaffInvite_expiresAt_idx" ON "StaffInvite"("expiresAt");
CREATE INDEX "StaffInvite_invitedByUserId_idx" ON "StaffInvite"("invitedByUserId");
CREATE INDEX "StaffInvite_acceptedByUserId_idx" ON "StaffInvite"("acceptedByUserId");

-- An invite cannot appoint an owner: ownership is set at claim time, and transferring it is a
-- different operation with different stakes.
ALTER TABLE "StaffInvite" ADD CONSTRAINT "StaffInvite_role_is_mod" CHECK ("role" = 'MOD');

-- AddForeignKey
ALTER TABLE "StaffInvite" ADD CONSTRAINT "StaffInvite_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffInvite" ADD CONSTRAINT "StaffInvite_invitedByUserId_fkey"
  FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffInvite" ADD CONSTRAINT "StaffInvite_acceptedByUserId_fkey"
  FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
