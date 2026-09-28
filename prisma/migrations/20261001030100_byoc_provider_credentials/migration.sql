-- Phase 15 track C, operator decision P1 (2026-09-28): BYOC provider keys for Enterprise
-- organisations. Key material is envelope-encrypted by the application; revoking wipes it.
-- Expand-only: one new table.

-- CreateTable
CREATE TABLE "studio"."provider_credentials" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "encryptedKey" TEXT,
    "encryptedSecondaryKey" TEXT,
    "hint" TEXT,
    "state" TEXT NOT NULL DEFAULT 'active',
    "lastTestedAt" TIMESTAMP(3),
    "lastTestResult" JSONB,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_credentials_organisationId_state_idx" ON "studio"."provider_credentials"("organisationId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "provider_credentials_organisationId_providerId_key" ON "studio"."provider_credentials"("organisationId", "providerId");
