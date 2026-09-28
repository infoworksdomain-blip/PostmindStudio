-- BACKLOG 17.3 (Phase 17, production hardening): the daily platform account-status check
-- (services/account-status.ts) records when it last checked each connection and what it found
-- (ok | needs_reconnect | unreachable). The index lets the hourly run pick the active connections
-- checked longest ago. Expand-only: two nullable columns and an index.

-- AlterTable
ALTER TABLE "studio"."platform_connections" ADD COLUMN "statusCheckedAt" TIMESTAMP(3),
ADD COLUMN "statusCheckOutcome" TEXT;

-- CreateIndex
CREATE INDEX "platform_connections_state_statusCheckedAt_idx" ON "studio"."platform_connections"("state", "statusCheckedAt");
