-- Phase 12 cost caps + alerting (track C): cost_alerts (one row per alert, deduplicated by the
-- unique key), notifications (in-app store, spec 14.4) and an index for the global daily cap.
-- Expand-only: new tables, a new enum and an index, safe for the running version
-- (runbooks/rollback.md).

-- CreateEnum
CREATE TYPE "studio"."CostAlertScope" AS ENUM ('PROJECT', 'ORG_DAILY', 'ORG_PROVIDER_DAILY', 'GLOBAL_DAILY');

-- CreateTable
CREATE TABLE "studio"."cost_alerts" (
    "id" TEXT NOT NULL,
    "scope" "studio"."CostAlertScope" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "organisationId" TEXT,
    "period" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "capPence" INTEGER NOT NULL,
    "spentPence" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."notifications" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "dedupeKey" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_usage_day_idx" ON "studio"."provider_usage"("day");

-- CreateIndex
CREATE INDEX "cost_alerts_createdAt_idx" ON "studio"."cost_alerts"("createdAt");

-- CreateIndex
CREATE INDEX "cost_alerts_organisationId_createdAt_idx" ON "studio"."cost_alerts"("organisationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "cost_alerts_scope_scopeId_period_threshold_key" ON "studio"."cost_alerts"("scope", "scopeId", "period", "threshold");

-- CreateIndex
CREATE INDEX "notifications_organisationId_createdAt_idx" ON "studio"."notifications"("organisationId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_organisationId_userId_readAt_idx" ON "studio"."notifications"("organisationId", "userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_organisationId_dedupeKey_key" ON "studio"."notifications"("organisationId", "dedupeKey");
