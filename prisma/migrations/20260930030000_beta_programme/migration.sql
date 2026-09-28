-- BACKLOG 14.11: beta programme. organisation_beta (cohort + "Plus for 30 days" override),
-- beta_feedback (in-app feedback) and safety_audit_items (Trust & Safety monthly audit sample).
-- Expand-only: three new tables, nothing existing changes (runbooks/rollback.md).

-- CreateTable
CREATE TABLE "studio"."organisation_beta" (
    "organisationId" TEXT NOT NULL,
    "cohort" TEXT NOT NULL,
    "plusUntil" TIMESTAMP(3),
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedByUserId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organisation_beta_pkey" PRIMARY KEY ("organisationId")
);

-- CreateTable
CREATE TABLE "studio"."beta_feedback" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "projectId" TEXT,
    "screen" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "beta_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."safety_audit_items" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "platformUrl" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "result" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "safety_audit_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organisation_beta_cohort_idx" ON "studio"."organisation_beta"("cohort");

-- CreateIndex
CREATE INDEX "beta_feedback_organisationId_createdAt_idx" ON "studio"."beta_feedback"("organisationId", "createdAt");

-- CreateIndex
CREATE INDEX "beta_feedback_kind_createdAt_idx" ON "studio"."beta_feedback"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "beta_feedback_createdAt_idx" ON "studio"."beta_feedback"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "safety_audit_items_period_publicationId_key" ON "studio"."safety_audit_items"("period", "publicationId");

-- CreateIndex
CREATE INDEX "safety_audit_items_period_result_idx" ON "studio"."safety_audit_items"("period", "result");
