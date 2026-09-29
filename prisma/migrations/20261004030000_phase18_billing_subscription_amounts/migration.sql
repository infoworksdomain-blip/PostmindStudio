-- Phase 18 Track C (expand-only): what each subscription is billed, so the admin MRR view and
-- the ENTERPRISE mapping (product metadata studio_tier; no lookup key) work from the stored row.
ALTER TABLE "studio"."subscriptions" ADD COLUMN "productTier" TEXT;
ALTER TABLE "studio"."subscriptions" ADD COLUMN "unitAmountPence" INTEGER;
ALTER TABLE "studio"."subscriptions" ADD COLUMN "currency" TEXT;
ALTER TABLE "studio"."subscriptions" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;
