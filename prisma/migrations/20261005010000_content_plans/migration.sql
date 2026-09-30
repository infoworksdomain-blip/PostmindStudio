-- 20.9 "Plan my month" (operator request 2026-09-30): expand-only. Two new tables, no existing
-- row changes. content_plans holds one month plan per request (window, posts a day, video share,
-- targets, status DRAFTING → DRAFT → GENERATING → SCHEDULED → COMPLETED / CANCELLED);
-- content_plan_items holds one row per planned post (slot, kind, topic, status, project once
-- generated). Tenant-scoped by organisationId like every Studio table.

-- CreateEnum
CREATE TYPE "studio"."ContentPlanStatus" AS ENUM ('DRAFTING', 'DRAFT', 'GENERATING', 'SCHEDULED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "studio"."ContentPlanItemKind" AS ENUM ('VIDEO', 'SLIDESHOW');

-- CreateEnum
CREATE TYPE "studio"."ContentPlanItemStatus" AS ENUM ('PLANNED', 'QUEUED', 'GENERATING', 'READY', 'SCHEDULED', 'POSTED', 'HELD', 'FAILED', 'SKIPPED', 'REMOVED');

-- CreateTable
CREATE TABLE "studio"."content_plans" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "scheduledByUserId" TEXT,
    "status" "studio"."ContentPlanStatus" NOT NULL DEFAULT 'DRAFTING',
    "startDate" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "postsPerDay" INTEGER NOT NULL,
    "useDripSlots" BOOLEAN NOT NULL DEFAULT false,
    "videoShare" INTEGER NOT NULL DEFAULT 50,
    "platforms" TEXT[],
    "targets" JSONB NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en-GB',
    "brandKitId" TEXT,
    "planTier" TEXT,
    "requestedCount" INTEGER NOT NULL DEFAULT 0,
    "cappedReason" TEXT,
    "holdReason" TEXT,
    "draftError" TEXT,
    "draftModel" TEXT,
    "generationStartedAt" TIMESTAMP(3),
    "scheduledAt" TIMESTAMP(3),
    "summaryEmailedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."content_plan_items" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "slotAt" TIMESTAMP(3) NOT NULL,
    "kind" "studio"."ContentPlanItemKind" NOT NULL,
    "angle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "slides" JSONB,
    "calendarDay" TEXT,
    "status" "studio"."ContentPlanItemStatus" NOT NULL DEFAULT 'PLANNED',
    "statusReason" TEXT,
    "projectId" TEXT,
    "quotaReservation" JSONB,
    "startedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_plans_organisationId_businessId_createdAt_idx" ON "studio"."content_plans"("organisationId", "businessId", "createdAt");

-- CreateIndex
CREATE INDEX "content_plans_status_updatedAt_idx" ON "studio"."content_plans"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "content_plan_items_planId_position_idx" ON "studio"."content_plan_items"("planId", "position");

-- CreateIndex
CREATE INDEX "content_plan_items_organisationId_slotAt_idx" ON "studio"."content_plan_items"("organisationId", "slotAt");

-- CreateIndex
CREATE INDEX "content_plan_items_projectId_idx" ON "studio"."content_plan_items"("projectId");

-- AddForeignKey
ALTER TABLE "studio"."content_plan_items" ADD CONSTRAINT "content_plan_items_planId_fkey" FOREIGN KEY ("planId") REFERENCES "studio"."content_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
