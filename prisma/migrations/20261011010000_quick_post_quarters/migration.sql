-- 23.3 "Cheap posts count ¼" (operator decision 2026-10-06): expand-only and idempotent.
-- Video packs are counted in QUARTERS of a video (a carousel, slideshow, wall of text or
-- hook + demo uses 1, a video 4, a UGC actor video 8), so the pack balance gets integer quarter
-- columns. The video-count columns (quantity, remaining) stay, unchanged, as legacy values.
--
-- Rollout: a pack bought while the previous release is still serving inserts without the new
-- NOT NULL columns and fails; the Stripe event stays unprocessed and the webhook sweeper credits
-- it once this release serves (billing/reconcile.ts sweepStripeEvents, every 10 minutes). Uses written by the previous release get
-- the column default (4 = one video), which is what that release charged.

-- AlterTable
ALTER TABLE "studio"."usage_credits" ADD COLUMN IF NOT EXISTS "quantityQuarters" INTEGER;
ALTER TABLE "studio"."usage_credits" ADD COLUMN IF NOT EXISTS "remainingQuarters" INTEGER;

-- Backfill: every existing pack video becomes 4 quarters (only rows not converted yet).
UPDATE "studio"."usage_credits" SET "quantityQuarters" = "quantity" * 4 WHERE "quantityQuarters" IS NULL;
UPDATE "studio"."usage_credits" SET "remainingQuarters" = "remaining" * 4 WHERE "remainingQuarters" IS NULL;

ALTER TABLE "studio"."usage_credits" ALTER COLUMN "quantityQuarters" SET NOT NULL;
ALTER TABLE "studio"."usage_credits" ALTER COLUMN "remainingQuarters" SET NOT NULL;

-- AlterTable
ALTER TABLE "studio"."usage_credit_uses" ADD COLUMN IF NOT EXISTS "quarters" INTEGER NOT NULL DEFAULT 4;

-- Backfill: a UGC actor video spent 2 pack videos (21.4), so its use took 8 quarters; every other
-- earlier use took one video (4, the default). Re-running sets the same value.
UPDATE "studio"."usage_credit_uses" AS u
SET "quarters" = 8
FROM "studio"."video_projects" AS p
WHERE p."id" = u."projectId"
  AND jsonb_typeof(p."metadata" -> 'ugc') = 'object'
  AND u."quarters" <> 8;
