-- Phase 13 track A3 (admin, automation and cost): BACKLOG 13.17 safety_reviews, 13.18
-- org_policies, 13.19 org_cost_caps, 13.21 auto_publish_outbox, 13.22 organisation_purges,
-- 13.24 notification_preferences, plus a provider_jobs(startedAt) index for 13.16 provider health.
-- Expand-only: six new tables, two new enums and an index, safe for the running version
-- (runbooks/rollback.md).

-- CreateEnum
CREATE TYPE "studio"."SafetyReviewState" AS ENUM ('PENDING', 'ALLOWED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "studio"."AutoPublishOutboxState" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "studio"."safety_reviews" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" "studio"."SafetyReviewState" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "details" JSONB,
    "renderIds" TEXT[],
    "planTier" TEXT NOT NULL,
    "decidedByUserId" TEXT,
    "decisionNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "safety_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."org_policies" (
    "organisationId" TEXT NOT NULL,
    "defaultReviewPolicy" "studio"."ReviewPolicy",
    "autoApproveAllowed" BOOLEAN NOT NULL DEFAULT true,
    "autoApproveTrustThreshold" INTEGER,
    "updatedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_policies_pkey" PRIMARY KEY ("organisationId")
);

-- CreateTable
CREATE TABLE "studio"."org_cost_caps" (
    "organisationId" TEXT NOT NULL,
    "dailyPence" INTEGER,
    "monthlyPence" INTEGER,
    "reason" TEXT NOT NULL,
    "updatedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_cost_caps_pkey" PRIMARY KEY ("organisationId")
);

-- CreateTable
CREATE TABLE "studio"."auto_publish_outbox" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "approvalTaskId" TEXT NOT NULL,
    "targetIndex" INTEGER NOT NULL,
    "target" JSONB NOT NULL,
    "planTier" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "state" "studio"."AutoPublishOutboxState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "publicationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_publish_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."organisation_purges" (
    "organisationId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "graceUntil" TIMESTAMP(3) NOT NULL,
    "channelsWiped" INTEGER NOT NULL,
    "projectsDeleted" INTEGER NOT NULL,
    "publicationsCancelled" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "hardDeletedAt" TIMESTAMP(3),

    CONSTRAINT "organisation_purges_pkey" PRIMARY KEY ("organisationId")
);

-- CreateTable
CREATE TABLE "studio"."notification_preferences" (
    "organisationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "inApp" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("organisationId","userId","kind")
);

-- CreateIndex
CREATE UNIQUE INDEX "safety_reviews_projectId_runId_kind_key" ON "studio"."safety_reviews"("projectId", "runId", "kind");

-- CreateIndex
CREATE INDEX "safety_reviews_state_createdAt_idx" ON "studio"."safety_reviews"("state", "createdAt");

-- CreateIndex
CREATE INDEX "safety_reviews_organisationId_createdAt_idx" ON "studio"."safety_reviews"("organisationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "auto_publish_outbox_approvalTaskId_targetIndex_key" ON "studio"."auto_publish_outbox"("approvalTaskId", "targetIndex");

-- CreateIndex
CREATE INDEX "auto_publish_outbox_state_nextAttemptAt_idx" ON "studio"."auto_publish_outbox"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "auto_publish_outbox_projectId_createdAt_idx" ON "studio"."auto_publish_outbox"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "organisation_purges_graceUntil_idx" ON "studio"."organisation_purges"("graceUntil");

-- CreateIndex
CREATE INDEX "provider_jobs_startedAt_idx" ON "studio"."provider_jobs"("startedAt");
