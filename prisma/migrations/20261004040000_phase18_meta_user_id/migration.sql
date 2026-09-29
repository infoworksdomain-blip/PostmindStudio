-- Phase 18 Track D (plans/phase-18.md §2.10): expand-only. Studio's own Meta login records the
-- Meta app-scoped user id on the Page / Instagram connections it creates, so the deauthorise and
-- data-deletion callbacks (signed_request user_id) can find and revoke them. Nullable; no existing
-- row changes.

-- AlterTable
ALTER TABLE "studio"."platform_connections" ADD COLUMN "metaUserId" TEXT;

-- CreateIndex
CREATE INDEX "platform_connections_metaUserId_idx" ON "studio"."platform_connections"("metaUserId");
