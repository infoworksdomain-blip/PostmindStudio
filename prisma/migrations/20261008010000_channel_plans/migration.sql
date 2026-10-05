-- 21.5 per-channel pricing (operator decision 2026-10-04), expand-only. The channel count is the
-- subscription item's quantity (already stored in "quantity") and the interval gains 'week'
-- (a text column, no enum change). What is new is the change waiting for the END of the period
-- (a Stripe subscription schedule's next phase: fewer channels or a shorter interval) and an
-- upgrade waiting for its payment (Stripe pending_update), so "Your plan" can say what happens
-- when. All nullable / defaulted; existing rows keep NULL / false.
ALTER TABLE "studio"."subscriptions" ADD COLUMN "scheduleId" TEXT;
ALTER TABLE "studio"."subscriptions" ADD COLUMN "pendingQuantity" INTEGER;
ALTER TABLE "studio"."subscriptions" ADD COLUMN "pendingLookupKey" TEXT;
ALTER TABLE "studio"."subscriptions" ADD COLUMN "pendingEffectiveAt" TIMESTAMP(3);
ALTER TABLE "studio"."subscriptions" ADD COLUMN "pendingUpdate" BOOLEAN NOT NULL DEFAULT false;