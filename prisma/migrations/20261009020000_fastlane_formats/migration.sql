-- 22.1 / 22.2 Fastlane-style formats (expand-only).
-- HOOK_DEMO: a short reaction hook clip, then the business's own demo video (metadata.hookDemo).
-- WALL_OF_TEXT: one large text block over a calm background video (metadata.wallOfText).
-- DEMO_VIDEO: the business's reusable demo-video uploads (the demo bank).
ALTER TYPE "studio"."VideoSourceType" ADD VALUE IF NOT EXISTS 'HOOK_DEMO';
ALTER TYPE "studio"."VideoSourceType" ADD VALUE IF NOT EXISTS 'WALL_OF_TEXT';
ALTER TYPE "studio"."UploadKind" ADD VALUE IF NOT EXISTS 'DEMO_VIDEO';
