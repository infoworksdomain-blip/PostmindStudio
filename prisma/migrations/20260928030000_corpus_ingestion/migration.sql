-- Corpus ingestion (operator decision 2026-09-27: the 50k library corpus needs no licence).
-- 1. LicenseScenario gains NOT_REQUIRED (operator-owned content; TEMPLATE + INSPIRE allowed).
-- 2. video_library_ingest_runs tracks every queued source for GET /admin/library/ingest/status.
-- Expand-only: a new enum value, a new enum and a new table, safe for the running version
-- (runbooks/rollback.md). The new enum value is not used inside this migration, so ADD VALUE
-- is safe inside Prisma's migration transaction (PostgreSQL 12+).

-- AlterEnum
ALTER TYPE "studio"."LicenseScenario" ADD VALUE 'NOT_REQUIRED';

-- CreateEnum
CREATE TYPE "studio"."LibraryIngestState" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'DUPLICATE', 'FAILED');

-- CreateTable
CREATE TABLE "studio"."video_library_ingest_runs" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceRef" TEXT,
    "language" TEXT,
    "state" "studio"."LibraryIngestState" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "libraryItemId" TEXT,
    "errorReason" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_library_ingest_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "video_library_ingest_runs_runId_key" ON "studio"."video_library_ingest_runs"("runId");

-- CreateIndex
CREATE INDEX "video_library_ingest_runs_state_updatedAt_idx" ON "studio"."video_library_ingest_runs"("state", "updatedAt");

-- CreateIndex
CREATE INDEX "video_library_ingest_runs_updatedAt_idx" ON "studio"."video_library_ingest_runs"("updatedAt");
