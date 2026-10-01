-- 20.13 captions and hashtags (operator request 2026-10-01): expand-only. One new table, one new
-- nullable column, no existing row changes. business_hashtag_settings holds, per business, the
-- business hashtag (NULL = derived from the business name) and the owner's "always include"
-- hashtags; content_plan_items.postCopy holds a planned post's caption and hashtags per platform.
-- Tenant-scoped by organisationId like every Studio table.

-- CreateTable
CREATE TABLE "studio"."business_hashtag_settings" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "primaryHashtag" TEXT,
    "alwaysHashtags" TEXT[],
    "updatedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_hashtag_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "business_hashtag_settings_organisationId_businessId_key" ON "studio"."business_hashtag_settings"("organisationId", "businessId");

-- AlterTable
ALTER TABLE "studio"."content_plan_items" ADD COLUMN "postCopy" JSONB;
