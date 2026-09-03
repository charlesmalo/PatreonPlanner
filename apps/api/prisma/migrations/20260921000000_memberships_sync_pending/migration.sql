-- We owe this reader a membership sync, and no stale Membership row will remind us.
--
-- Additive and defaulted, so it is safe to apply while the old code is still running: existing
-- rows become `false`, which is exactly what they mean — nothing is owed for a reader whose
-- memberships were last read successfully.
ALTER TABLE "User" ADD COLUMN "membershipsSyncPending" BOOLEAN NOT NULL DEFAULT false;
