-- Phase 15 track D (governance, admin and cost controls). Expand-only: nullable columns or
-- columns with defaults, one new enum; no new tables.

-- 15.D7 / Addendum A3.8: staff categorisation review of corpus items (accept the automatic
-- classification, override it, or reject the item) and when an item was last re-analysed.
-- CreateEnum
CREATE TYPE "studio"."LibraryCategoryReview" AS ENUM ('ACCEPTED', 'OVERRIDDEN', 'REJECTED');

-- AlterTable
ALTER TABLE "studio"."video_library" ADD COLUMN     "categoryReview" "studio"."LibraryCategoryReview",
ADD COLUMN     "categoryReviewedAt" TIMESTAMP(3),
ADD COLUMN     "reanalysedAt" TIMESTAMP(3);

-- 15.D8 / Addendum A11.2: "The checkbox text is preserved with the scan record for audit."
-- Nullable: historic scans and scheduled rescans (no person ticked a box) have none.
-- AlterTable
ALTER TABLE "studio"."website_scans" ADD COLUMN     "ownershipStatement" TEXT;

-- 15.D8 / Addendum A13: "low-confidence classifications flagged for user review before use".
-- AlterTable
ALTER TABLE "studio"."business_profiles" ADD COLUMN     "classifierConfidence" DOUBLE PRECISION,
ADD COLUMN     "needsReview" BOOLEAN NOT NULL DEFAULT false;
