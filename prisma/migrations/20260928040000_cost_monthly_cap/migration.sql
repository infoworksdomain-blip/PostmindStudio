-- Operator decision 2 (2026-09-27): monthly organisation cost cap (spec 14.4 "Cost 80% of
-- monthly cap"). A new alert scope for the per-(organisation, calendar month UTC) alerts and an
-- index so the month-to-date sum reads one organisation's rows by day range instead of scanning
-- the (organisationId, provider, day) unique index across every provider.
-- Expand-only: an enum value and an index, safe for the running version (runbooks/rollback.md).

-- AlterEnum
ALTER TYPE "studio"."CostAlertScope" ADD VALUE 'ORG_MONTHLY';

-- CreateIndex
CREATE INDEX "provider_usage_organisationId_day_idx" ON "studio"."provider_usage"("organisationId", "day");
