-- Phase 18 (plans/phase-18.md §4), Track 0: the whole standalone-SaaS schema in one expand-only
-- migration. New tables only (Better Auth identity, organisations, businesses, local audit log,
-- Stripe billing, entitlements, top-up credits, email outbox and suppressions) plus one nullable
-- column (platform_connections.connectedVia). No existing column, constraint or row changes; no
-- foreign keys are added to existing tables.

-- AlterTable
ALTER TABLE "studio"."platform_connections" ADD COLUMN     "connectedVia" TEXT;

-- CreateTable
CREATE TABLE "studio"."users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "twoFactorEnabled" BOOLEAN DEFAULT false,
    "role" TEXT DEFAULT 'user',
    "banned" BOOLEAN DEFAULT false,
    "banReason" TEXT,
    "banExpires" TIMESTAMP(3),
    "locale" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."sessions" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "activeOrganizationId" TEXT,
    "impersonatedBy" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."auth_accounts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."verifications" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."two_factors" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verified" BOOLEAN DEFAULT true,
    "failedVerificationCount" INTEGER DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "two_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."organisations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" TEXT,
    "country" TEXT,
    "defaultLocale" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."members" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."invitations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inviterId" TEXT NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."businesses" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."audit_log" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT,
    "actorType" TEXT NOT NULL,
    "impersonatorUserId" TEXT,
    "organisationId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "metadata" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "correlationId" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."billing_customers" (
    "organisationId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "idempotencyNonce" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "billing_customers_pkey" PRIMARY KEY ("organisationId")
);

-- CreateTable
CREATE TABLE "studio"."subscriptions" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lookupKey" TEXT,
    "interval" TEXT,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "trialEnd" TIMESTAMP(3),
    "stripeUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."org_entitlements" (
    "organisationId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "graceUntil" TIMESTAMP(3),
    "overrides" JSONB,
    "trialStartedAt" TIMESTAMP(3),
    "everPaidAt" TIMESTAMP(3),
    "reason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "org_entitlements_pkey" PRIMARY KEY ("organisationId")
);

-- CreateTable
CREATE TABLE "studio"."usage_credits" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "packLookupKey" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "stripeCheckoutSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_credits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."usage_credit_uses" (
    "id" TEXT NOT NULL,
    "creditId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_credit_uses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "objectId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."trial_fingerprints" (
    "fingerprint" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trial_fingerprints_pkey" PRIMARY KEY ("fingerprint")
);

-- CreateTable
CREATE TABLE "studio"."email_outbox" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "organisationId" TEXT,
    "userId" TEXT,
    "toAddress" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "providerMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."email_suppressions" (
    "addressHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("addressHash")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "studio"."users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "studio"."sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "studio"."sessions"("userId");

-- CreateIndex
CREATE INDEX "auth_accounts_userId_idx" ON "studio"."auth_accounts"("userId");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "studio"."verifications"("identifier");

-- CreateIndex
CREATE INDEX "two_factors_secret_idx" ON "studio"."two_factors"("secret");

-- CreateIndex
CREATE INDEX "two_factors_userId_idx" ON "studio"."two_factors"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "organisations_slug_key" ON "studio"."organisations"("slug");

-- CreateIndex
CREATE INDEX "members_userId_idx" ON "studio"."members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "members_organizationId_userId_key" ON "studio"."members"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "invitations_organizationId_idx" ON "studio"."invitations"("organizationId");

-- CreateIndex
CREATE INDEX "invitations_email_idx" ON "studio"."invitations"("email");

-- CreateIndex
CREATE INDEX "businesses_organisationId_deletedAt_idx" ON "studio"."businesses"("organisationId", "deletedAt");

-- CreateIndex
CREATE INDEX "audit_log_organisationId_occurredAt_idx" ON "studio"."audit_log"("organisationId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_log_actorUserId_occurredAt_idx" ON "studio"."audit_log"("actorUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_log_occurredAt_idx" ON "studio"."audit_log"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "billing_customers_stripeCustomerId_key" ON "studio"."billing_customers"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "subscriptions_organisationId_idx" ON "studio"."subscriptions"("organisationId");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "studio"."subscriptions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "usage_credits_stripeCheckoutSessionId_key" ON "studio"."usage_credits"("stripeCheckoutSessionId");

-- CreateIndex
CREATE INDEX "usage_credits_organisationId_kind_expiresAt_idx" ON "studio"."usage_credits"("organisationId", "kind", "expiresAt");

-- CreateIndex
CREATE INDEX "usage_credit_uses_organisationId_month_idx" ON "studio"."usage_credit_uses"("organisationId", "month");

-- CreateIndex
CREATE INDEX "usage_credit_uses_creditId_idx" ON "studio"."usage_credit_uses"("creditId");

-- CreateIndex
CREATE UNIQUE INDEX "usage_credit_uses_projectId_month_key" ON "studio"."usage_credit_uses"("projectId", "month");

-- CreateIndex
CREATE INDEX "stripe_events_processedAt_receivedAt_idx" ON "studio"."stripe_events"("processedAt", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_outbox_idempotencyKey_key" ON "studio"."email_outbox"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "email_outbox_providerMessageId_key" ON "studio"."email_outbox"("providerMessageId");

-- CreateIndex
CREATE INDEX "email_outbox_state_createdAt_idx" ON "studio"."email_outbox"("state", "createdAt");

-- CreateIndex
CREATE INDEX "email_outbox_userId_idx" ON "studio"."email_outbox"("userId");

-- AddForeignKey
ALTER TABLE "studio"."sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "studio"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."auth_accounts" ADD CONSTRAINT "auth_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "studio"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."two_factors" ADD CONSTRAINT "two_factors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "studio"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."members" ADD CONSTRAINT "members_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "studio"."organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."members" ADD CONSTRAINT "members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "studio"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."invitations" ADD CONSTRAINT "invitations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "studio"."organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."invitations" ADD CONSTRAINT "invitations_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "studio"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- §2.11: one live business per (organisation, case-insensitive name). Partial expression index,
-- not expressible in Prisma.
CREATE UNIQUE INDEX "businesses_org_lower_name_live_key"
  ON "studio"."businesses" ("organisationId", lower("name"))
  WHERE "deletedAt" IS NULL;

-- §2.6: the audit log is append-only. UPDATE / DELETE / TRUNCATE are rejected unless the
-- transaction ran `SET LOCAL studio.audit_retention = 'on'` (the retention job only).
CREATE OR REPLACE FUNCTION "studio"."audit_log_append_only"() RETURNS trigger AS $$
BEGIN
  IF current_setting('studio.audit_retention', true) = 'on' THEN
    IF TG_OP = 'UPDATE' THEN
      RETURN NEW;
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'studio.audit_log is append-only (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_log_append_only_row"
  BEFORE UPDATE OR DELETE ON "studio"."audit_log"
  FOR EACH ROW EXECUTE FUNCTION "studio"."audit_log_append_only"();

CREATE TRIGGER "audit_log_append_only_truncate"
  BEFORE TRUNCATE ON "studio"."audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "studio"."audit_log_append_only"();
