-- What an account paid, and nothing about who they are.
--
-- Additive only: a new table and its indexes. Nothing here reads, rewrites or drops an existing
-- column, so it needs no expand/contract sequence and is safe to apply while the old code runs.
CREATE TABLE "PaymentReceipt" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerReceiptId" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentReceipt_pkey" PRIMARY KEY ("id")
);

-- The reader's own history, newest first. Carries id because two receipts can share a paidAt,
-- and a keyset without a total order silently drops rows at the page boundary.
CREATE INDEX "PaymentReceipt_userId_paidAt_id_idx" ON "PaymentReceipt"("userId", "paidAt", "id");

-- What makes writing a receipt idempotent: a redelivered webhook carries the same provider
-- reference, and the second insert loses this rather than duplicating somebody's payment history.
CREATE UNIQUE INDEX "PaymentReceipt_provider_providerReceiptId_key" ON "PaymentReceipt"("provider", "providerReceiptId");

ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
