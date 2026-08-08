-- CreateIndex
CREATE INDEX "Creator_ownerUserId_idx" ON "Creator"("ownerUserId");

-- CreateIndex
CREATE INDEX "Membership_creatorId_idx" ON "Membership"("creatorId");

-- CreateIndex
CREATE INDEX "Membership_currentTierId_idx" ON "Membership"("currentTierId");

-- CreateIndex
CREATE INDEX "Tier_creatorId_idx" ON "Tier"("creatorId");
