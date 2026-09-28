-- Phase 15 Track B (composition and media quality). Expand-only: new nullable columns and new
-- enum values, safe for the running version (runbooks/rollback.md). The new UploadKind values are
-- not used inside this migration, so ADD VALUE may run in the migration's transaction.

-- 15.B1 brand-kit soft delete (spec 8.5 "Soft-delete").
ALTER TABLE "studio"."brand_kits" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- 15.B1 brand-kit media uploads (logo, watermark, intro/outro cards, fonts).
ALTER TYPE "studio"."UploadKind" ADD VALUE 'BRAND_LOGO';
ALTER TYPE "studio"."UploadKind" ADD VALUE 'BRAND_WATERMARK';
ALTER TYPE "studio"."UploadKind" ADD VALUE 'BRAND_CARD';
ALTER TYPE "studio"."UploadKind" ADD VALUE 'BRAND_FONT';
ALTER TABLE "studio"."video_uploads" ADD COLUMN "licenceConfirmedAt" TIMESTAMP(3);
ALTER TABLE "studio"."video_uploads" ADD COLUMN "fontFamily" TEXT;

-- 15.B2 / 15.B6 what composition put on the timeline (quality checks + composition cache).
ALTER TABLE "studio"."video_renders" ADD COLUMN "composition" JSONB;

-- 15.B7 per-project render options (fps, 4K YouTube, 720p drafts).
ALTER TABLE "studio"."video_projects" ADD COLUMN "renderOptions" JSONB;
