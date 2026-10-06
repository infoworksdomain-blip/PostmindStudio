-- 22.7 TikTok drafts (operator 2026-10-06): expand-only. One nullable column on
-- platform_connections: 'drafts' | 'direct' | NULL. Existing rows stay NULL, which keeps direct
-- posting for them; new TikTok connections are written with 'drafts' by the OAuth callback.

-- AlterTable
ALTER TABLE "studio"."platform_connections" ADD COLUMN "tiktokPostMode" TEXT;
