-- Phase 13 track A4 (BACKLOG 13.25 + 13.27). Expand-only, safe for the running version
-- (runbooks/rollback.md): a nullable column, a new enum and a new table.
-- 1. video_shots.sfxCue — the Layer 2 sound-effect cue for a shot (13.27).
-- 2. content_safety_tasks — Hive async moderation tasks for renders > 90 s (13.25). Only the
--    SHA-256 of each per-task callback token is stored.

-- AlterTable
ALTER TABLE "studio"."video_shots" ADD COLUMN "sfxCue" TEXT;

-- CreateEnum
CREATE TYPE "studio"."ContentSafetyTaskState" AS ENUM ('SUBMITTED', 'CALLBACK_RECEIVED', 'SETTLED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "studio"."content_safety_tasks" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "renderId" TEXT NOT NULL,
    "planTier" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerJobRowId" TEXT,
    "providerTaskId" TEXT,
    "callbackTokenHash" TEXT NOT NULL,
    "state" "studio"."ContentSafetyTaskState" NOT NULL DEFAULT 'SUBMITTED',
    "result" JSONB,
    "errorReason" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "callbackAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_safety_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_safety_tasks_callbackTokenHash_key" ON "studio"."content_safety_tasks"("callbackTokenHash");

-- CreateIndex
CREATE INDEX "content_safety_tasks_providerTaskId_idx" ON "studio"."content_safety_tasks"("providerTaskId");

-- CreateIndex
CREATE INDEX "content_safety_tasks_projectId_runId_idx" ON "studio"."content_safety_tasks"("projectId", "runId");

-- CreateIndex
CREATE UNIQUE INDEX "content_safety_tasks_renderId_runId_key" ON "studio"."content_safety_tasks"("renderId", "runId");
