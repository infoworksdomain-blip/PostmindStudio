-- Phase 15 track E, operator decision P8 (2026-09-28): external reviewers leaving feedback on a
-- share link may type an email address (optional; shown to the organisation only).
-- Expand-only: one nullable column.

-- AlterTable
ALTER TABLE "studio"."share_link_comments" ADD COLUMN     "authorEmail" TEXT;
