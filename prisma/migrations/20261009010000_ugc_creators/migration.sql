-- 22.3 reusable AI creators (expand-only, safe for the running version: runbooks/rollback.md).
-- Two new tables and one new enum; no existing row or column changes. A business makes a UGC
-- actor once (creators) and reuses the same face across videos; each portrait image is a
-- creator_portraits row (assets bucket, never the image library). Tenant-scoped by
-- organisationId + businessId like every Studio table.

-- CreateEnum
CREATE TYPE "studio"."CreatorStatus" AS ENUM ('DRAFT', 'READY', 'RETIRED');

-- CreateTable
CREATE TABLE "studio"."creators" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "ageRange" TEXT NOT NULL,
    "setting" TEXT NOT NULL,
    "appearance" TEXT,
    "voiceTone" TEXT,
    "description" TEXT NOT NULL,
    "status" "studio"."CreatorStatus" NOT NULL DEFAULT 'DRAFT',
    "portraitId" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "portraitError" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "retiredByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."creator_portraits" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "s3Bucket" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "prompt" TEXT,
    "instructions" TEXT,
    "providerId" TEXT,
    "providerJobId" TEXT,
    "costPence" INTEGER NOT NULL DEFAULT 0,
    "consentAttestedByUserId" TEXT,
    "consentAttestedAt" TIMESTAMP(3),
    "consentStatement" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_portraits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "creators_organisationId_businessId_status_idx" ON "studio"."creators"("organisationId", "businessId", "status");

-- CreateIndex
CREATE INDEX "creator_portraits_creatorId_createdAt_idx" ON "studio"."creator_portraits"("creatorId", "createdAt");

-- CreateIndex
CREATE INDEX "creator_portraits_organisationId_source_createdAt_idx" ON "studio"."creator_portraits"("organisationId", "source", "createdAt");
