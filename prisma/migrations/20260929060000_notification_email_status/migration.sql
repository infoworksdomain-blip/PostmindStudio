-- BACKLOG 13.33: email delivery state per notification. NULL = no recipient asked for email;
-- 'pending_setup' = someone opted in but no email sender exists yet (STUDIO_EMAIL_PROVIDER unset,
-- or Core's email API not published); 'sent' / 'failed' once a sender exists.
-- Expand-only: one nullable column, safe for the running version (runbooks/rollback.md).

-- AlterTable
ALTER TABLE "studio"."notifications" ADD COLUMN "emailStatus" TEXT;
