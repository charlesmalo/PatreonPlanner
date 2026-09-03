-- Addresses this application must stop writing to.
--
-- Additive only: one enum, one table, one index. Nothing here reads, rewrites or drops an
-- existing column, so it is safe to apply while the old code is still running.
CREATE TYPE "SuppressionReason" AS ENUM ('BOUNCED', 'COMPLAINED');

CREATE TABLE "EmailSuppression" (
    -- The address is the key. Lowercased by the application on the way in: addresses are
    -- case-insensitive in the part that routes them, and a list that misses "Ada@example.com"
    -- because it holds "ada@example.com" protects nothing.
    "address" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("address")
);

CREATE INDEX "EmailSuppression_createdAt_idx" ON "EmailSuppression"("createdAt");
