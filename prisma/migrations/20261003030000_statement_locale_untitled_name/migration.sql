-- BACKLOG 17.8 / 17.9 (Phase 17). Expand-only: four nullable columns and one relaxed NOT NULL.
--   17.8: website_scans records the locale and catalogue key of the approved ownership statement
--         (the text stays in "ownershipStatement"); voice_profiles records the locale and key of
--         the consent statement shown. Older rows keep NULL in the new columns.
--   17.9: video_projects.name may be NULL — "no name given" — so the UI renders "Untitled video"
--         in the reader's language instead of storing the English words. Existing rows are kept
--         (readers treat the legacy literal 'Untitled video' as untitled).

-- AlterTable
ALTER TABLE "studio"."website_scans" ADD COLUMN "ownershipStatementLocale" TEXT,
ADD COLUMN "ownershipStatementKey" TEXT;

-- AlterTable
ALTER TABLE "studio"."voice_profiles" ADD COLUMN "consentStatementLocale" TEXT,
ADD COLUMN "consentStatementKey" TEXT;

-- AlterTable
ALTER TABLE "studio"."video_projects" ALTER COLUMN "name" DROP NOT NULL;
