-- 22.4 Blitz + 22.5 Automations (operator request 2026-10-05/06): expand-only. Four new tables
-- (content_angles, content_mix_preferences, blitz_suggestions, automations), two new enums and
-- four nullable columns on the month-plan tables (content_plans.automationId,
-- content_plan_items.format / angleId / fingerprint). No existing row changes. Tenant-scoped by
-- organisationId (+ businessId) like every Studio table.

-- CreateEnum
CREATE TYPE "studio"."BlitzSuggestionStatus" AS ENUM ('RENDERING', 'READY', 'KEPT', 'SKIPPED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "studio"."AutomationStatus" AS ENUM ('DRAFT', 'GENERATING', 'REVIEW', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "studio"."content_plans" ADD COLUMN "automationId" TEXT;

-- AlterTable
ALTER TABLE "studio"."content_plan_items" ADD COLUMN "format" TEXT,
ADD COLUMN "angleId" TEXT,
ADD COLUMN "fingerprint" TEXT;

-- CreateTable
CREATE TABLE "studio"."content_angles" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "targetAudience" TEXT NOT NULL DEFAULT '',
    "weight" INTEGER NOT NULL DEFAULT 50,
    "source" TEXT NOT NULL DEFAULT 'owner',
    "retiredAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_angles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."content_mix_preferences" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "formatWeights" JSONB NOT NULL,
    "remixPercent" INTEGER NOT NULL DEFAULT 20,
    "mentionBusinessPercent" INTEGER NOT NULL DEFAULT 30,
    "captionStyleWeights" JSONB,
    "creatorChance" INTEGER NOT NULL DEFAULT 0,
    "adjustments" JSONB,
    "updatedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_mix_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."blitz_suggestions" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "angleId" TEXT,
    "format" TEXT NOT NULL,
    "status" "studio"."BlitzSuggestionStatus" NOT NULL,
    "copy" JSONB NOT NULL,
    "whyItWorks" TEXT NOT NULL,
    "mentionBusiness" BOOLEAN NOT NULL DEFAULT false,
    "remixLibraryItemId" TEXT,
    "remixMode" TEXT,
    "previewImageId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "projectId" TEXT,
    "failureReason" TEXT,
    "skipReason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blitz_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."automations" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "studio"."AutomationStatus" NOT NULL DEFAULT 'DRAFT',
    "cadence" JSONB NOT NULL,
    "duration" TEXT NOT NULL,
    "platforms" TEXT[],
    "targets" JSONB NOT NULL,
    "approvalMode" TEXT NOT NULL DEFAULT 'review',
    "mixSnapshot" JSONB,
    "costCeilingPence" INTEGER,
    "timezone" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en-GB',
    "planTier" TEXT,
    "capabilities" TEXT[],
    "currentPlanId" TEXT,
    "periodIndex" INTEGER NOT NULL DEFAULT 0,
    "pauseReason" TEXT,
    "activatedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "lastInsightAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_plans_automationId_idx" ON "studio"."content_plans"("automationId");

-- CreateIndex
CREATE INDEX "content_angles_organisationId_businessId_retiredAt_idx" ON "studio"."content_angles"("organisationId", "businessId", "retiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "content_mix_preferences_organisationId_businessId_key" ON "studio"."content_mix_preferences"("organisationId", "businessId");

-- CreateIndex
CREATE INDEX "blitz_suggestions_organisationId_businessId_status_idx" ON "studio"."blitz_suggestions"("organisationId", "businessId", "status");

-- CreateIndex
CREATE INDEX "blitz_suggestions_organisationId_businessId_createdAt_idx" ON "studio"."blitz_suggestions"("organisationId", "businessId", "createdAt");

-- CreateIndex
CREATE INDEX "blitz_suggestions_projectId_idx" ON "studio"."blitz_suggestions"("projectId");

-- CreateIndex
CREATE INDEX "automations_organisationId_businessId_createdAt_idx" ON "studio"."automations"("organisationId", "businessId", "createdAt");

-- CreateIndex
CREATE INDEX "automations_status_updatedAt_idx" ON "studio"."automations"("status", "updatedAt");
