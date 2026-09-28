-- Phase 14 track 1 (BACKLOG 14.1 + 14.4). Additive only: no new tables.

-- 14.1 hard deletion after the purge grace: organisation_purges is the tombstone.
ALTER TABLE "studio"."organisation_purges"
  ADD COLUMN "hardDeleteStartedAt" TIMESTAMP(3),
  ADD COLUMN "hardDeleteAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hardDeleteSummary" JSONB,
  ADD COLUMN "hardDeleteError" TEXT;

-- 14.4 ownership confirmation stored per scan (gates the browser-render fallback).
ALTER TABLE "studio"."website_scans"
  ADD COLUMN "ownershipConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "ownershipConfirmedByUserId" TEXT;
