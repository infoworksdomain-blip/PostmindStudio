-- BACKLOG 16.5 (Phase 16, multilingual Studio): a notification carries a message key and its ICU
-- parameters so the app renders it in the reader's locale (messages/<locale>.json →
-- notifications.<key>.title/body). title/body keep the English text as the fallback for older
-- clients, email and the outbound webhook. Expand-only: two nullable columns.

-- AlterTable
ALTER TABLE "studio"."notifications" ADD COLUMN "messageKey" TEXT,
ADD COLUMN "messageParams" JSONB;
