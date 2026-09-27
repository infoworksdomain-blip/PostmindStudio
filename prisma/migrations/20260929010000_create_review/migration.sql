-- Phase 13 track A1 (create and review).
-- 1. 13.4 per-slide overlays: text_overlays.slideId (FK to slideshow_slides, cascade on delete).
-- 2. 13.5 uploads: new table video_uploads with enums UploadKind / UploadState.
-- Expand-only: a nullable column, an index, a new table and new enums, safe for the running
-- version (runbooks/rollback.md).

-- AlterTable
ALTER TABLE "studio"."text_overlays" ADD COLUMN "slideId" TEXT;

-- CreateIndex
CREATE INDEX "text_overlays_slideId_idx" ON "studio"."text_overlays"("slideId");

-- AddForeignKey
ALTER TABLE "studio"."text_overlays" ADD CONSTRAINT "text_overlays_slideId_fkey" FOREIGN KEY ("slideId") REFERENCES "studio"."slideshow_slides"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "studio"."UploadKind" AS ENUM ('SOURCE_VIDEO', 'SLIDE_CLIP');

-- CreateEnum
CREATE TYPE "studio"."UploadState" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "studio"."video_uploads" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "kind" "studio"."UploadKind" NOT NULL,
    "projectId" TEXT,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "declaredBytes" BIGINT NOT NULL,
    "s3Bucket" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "state" "studio"."UploadState" NOT NULL DEFAULT 'PENDING',
    "assetId" TEXT,
    "durationSec" DOUBLE PRECISION,
    "widthPx" INTEGER,
    "heightPx" INTEGER,
    "sizeBytes" BIGINT,
    "errorReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_uploads_organisationId_createdAt_idx" ON "studio"."video_uploads"("organisationId", "createdAt");

-- CreateIndex
CREATE INDEX "video_uploads_projectId_idx" ON "studio"."video_uploads"("projectId");
