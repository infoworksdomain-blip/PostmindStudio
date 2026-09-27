-- Phase 12 automation (track A): per-template publish defaults (DERIVED column) for
-- "auto-publish on approval per template" (spec 3), and an index for GET /templates.
-- Expand-only: a nullable column and an index, safe for the running version (runbooks/rollback.md).

-- AlterTable
ALTER TABLE "studio"."templates" ADD COLUMN "publishDefaults" JSONB;

-- CreateIndex
CREATE INDEX "templates_organisationId_category_idx" ON "studio"."templates"("organisationId", "category");
