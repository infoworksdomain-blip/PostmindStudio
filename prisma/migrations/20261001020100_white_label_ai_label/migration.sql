-- Phase 15 Track B, operator decisions P2 (white-label outputs) and P6 (optional on-video
-- "AI-generated" label). Expand-only: two NOT NULL columns with constant defaults (metadata-only
-- in PostgreSQL 11+), safe for the running version (runbooks/rollback.md).

-- P6: per-brand-kit on-video AI disclosure label, default off.
ALTER TABLE "studio"."brand_kits" ADD COLUMN "aiDisclosureLabel" BOOLEAN NOT NULL DEFAULT false;

-- P2: organisations flagged white-label by PostMind staff (ENTERPRISE is white-label regardless).
ALTER TABLE "studio"."org_policies" ADD COLUMN "whiteLabel" BOOLEAN NOT NULL DEFAULT false;
