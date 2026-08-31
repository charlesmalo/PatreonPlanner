-- Additive only: two new columns with defaults. Safe for a rolling deploy.

-- Off for everybody, including accounts that already exist. The address came from Patreon's OAuth
-- for signing in; sending a digest to it is a different purpose from the one it was given for.
ALTER TABLE "User" ADD COLUMN "emailDigest" BOOLEAN NOT NULL DEFAULT false;

-- The watermark. Moves only when a provider accepted the message, so a failed send leaves today's
-- news in tomorrow's digest rather than losing it.
ALTER TABLE "User" ADD COLUMN "lastDigestAt" TIMESTAMP(3);

-- The digest job reads the readers who asked for one. Partial: almost nobody has, and an index
-- over every row to find the few would be paid on every write to User.
CREATE INDEX "User_emailDigest_idx" ON "User"("emailDigest") WHERE "emailDigest" = true;
