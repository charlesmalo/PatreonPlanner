-- Additive only: one nullable column and its index. Safe for a rolling deploy.

-- The order a subscription was created by. A refund arrives as an *order* event and the order
-- payload carries no subscription id — subscriptions have an order_id, not the reverse — so
-- without this there is no way back from "this order was refunded" to "revoke that entitlement".
--
-- Nullable: rows written before this existed have no order recorded, and a refund of one of those
-- cannot be matched. Those are reconciled when their period runs out instead.
ALTER TABLE "Subscription" ADD COLUMN "providerOrderId" TEXT;

CREATE INDEX "Subscription_providerOrderId_idx" ON "Subscription"("providerOrderId");
