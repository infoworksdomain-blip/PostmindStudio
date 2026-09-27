-- Phase 13 track A2 (BACKLOG 13.10–13.15). Expand-only: new nullable/defaulted columns, one new
-- enum and two new tables, all safe for the running version (runbooks/rollback.md).
--   13.10 website_scans: homepage validators (ETag / Last-Modified) for skip-if-unchanged
--         rescans, the last "unchanged" check, the tier the scan ran at and what triggered it.
--   13.11 domain_verifications (NEW TABLE) + enum DomainVerificationState.
--   13.12 image_library.phash: 64-bit dHash (hex) for near-duplicate detection.
--   13.13 voice_profiles: state, consent record, sample stats, soft delete.
--   13.14 onboarding_states (NEW TABLE): the /welcome wizard's state per user.
--   13.15 video_library_ingest_runs.item: the submitted item, for resubmitting failures.

-- AlterTable
ALTER TABLE "studio"."website_scans" ADD COLUMN "etag" TEXT,
ADD COLUMN "lastModified" TEXT,
ADD COLUMN "checkedUnchangedAt" TIMESTAMP(3),
ADD COLUMN "planTier" TEXT,
ADD COLUMN "trigger" TEXT NOT NULL DEFAULT 'manual';

-- CreateIndex
CREATE INDEX "website_scans_state_completedAt_idx" ON "studio"."website_scans"("state", "completedAt");

-- CreateEnum
CREATE TYPE "studio"."DomainVerificationState" AS ENUM ('PENDING', 'VERIFIED', 'EXPIRED', 'DISPUTED', 'PURGED');

-- CreateTable
CREATE TABLE "studio"."domain_verifications" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "state" "studio"."DomainVerificationState" NOT NULL DEFAULT 'PENDING',
    "requestedByUserId" TEXT NOT NULL,
    "checkAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "disputedAt" TIMESTAMP(3),
    "disputedByUserId" TEXT,
    "disputeReason" TEXT,
    "purgeDueAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),
    "purgeSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "domain_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "domain_verifications_organisationId_businessId_createdAt_idx" ON "studio"."domain_verifications"("organisationId", "businessId", "createdAt");

-- CreateIndex
CREATE INDEX "domain_verifications_state_lastCheckedAt_idx" ON "studio"."domain_verifications"("state", "lastCheckedAt");

-- AlterTable
ALTER TABLE "studio"."image_library" ADD COLUMN "phash" TEXT;

-- AlterTable
ALTER TABLE "studio"."voice_profiles" ADD COLUMN "state" TEXT NOT NULL DEFAULT 'READY',
ADD COLUMN "speakerName" TEXT,
ADD COLUMN "consentStatement" TEXT,
ADD COLUMN "consentGivenByUserId" TEXT,
ADD COLUMN "consentGivenAt" TIMESTAMP(3),
ADD COLUMN "consentS3Bucket" TEXT,
ADD COLUMN "consentS3Key" TEXT,
ADD COLUMN "sampleCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "sampleSeconds" DOUBLE PRECISION,
ADD COLUMN "deletedAt" TIMESTAMP(3),
ADD COLUMN "deletedByUserId" TEXT,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "voice_profiles_organisationId_businessId_idx" ON "studio"."voice_profiles"("organisationId", "businessId");

-- CreateTable
CREATE TABLE "studio"."onboarding_states" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "step" TEXT NOT NULL DEFAULT 'connect',
    "completed" TEXT[],
    "firstVideoProjectId" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_states_organisationId_userId_key" ON "studio"."onboarding_states"("organisationId", "userId");

-- AlterTable
ALTER TABLE "studio"."video_library_ingest_runs" ADD COLUMN "item" JSONB;
