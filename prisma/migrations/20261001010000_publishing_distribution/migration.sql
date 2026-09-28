-- Phase 15 Track A (publishing and distribution). Expand-only: one new table and two nullable
-- columns, safe for the running version (runbooks/rollback.md).
--   15.A5 drip queue per business (spec 3.1 "drip queue", 9.9 stagger) and absolute schedule
--   times on auto-publish outbox rows (SCHEDULED projects, drip slots).

-- AlterTable
ALTER TABLE "studio"."auto_publish_outbox" ADD COLUMN "scheduledFor" TIMESTAMP(3),
ADD COLUMN "slotAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "auto_publish_outbox_slotAt_idx" ON "studio"."auto_publish_outbox"("slotAt");

-- CreateTable
CREATE TABLE "studio"."drip_queues" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "slots" JSONB NOT NULL,
    "platforms" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drip_queues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drip_queues_organisationId_businessId_key" ON "studio"."drip_queues"("organisationId", "businessId");
