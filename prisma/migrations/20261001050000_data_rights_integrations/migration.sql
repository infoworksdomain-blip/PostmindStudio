-- Phase 15 track E (data rights, integrations and sharing): 15.E1 data_exports, 15.E2
-- business_purges, 15.E3 publication_conversations, 15.E4 takedown_requests, 15.E5 share_links +
-- share_link_comments, 15.W2 usage_events (Core usage outbox), 15.W3 calendar_shadows (Core
-- calendar outbox), and 15.E6 style_memories.pinned / disabled / editedByUserAt.
-- Expand-only: eight new tables, three new columns with defaults, safe for the running version
-- (runbooks/rollback.md).

-- AlterTable
ALTER TABLE "studio"."style_memories" ADD COLUMN     "disabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "editedByUserAt" TIMESTAMP(3),
ADD COLUMN     "pinned" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "studio"."data_exports" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "include" TEXT[],
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "activeKey" TEXT,
    "s3Bucket" TEXT,
    "s3Key" TEXT,
    "bytes" INTEGER,
    "summary" JSONB,
    "errorReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."business_purges" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "graceUntil" TIMESTAMP(3) NOT NULL,
    "projectsDeleted" INTEGER NOT NULL,
    "publicationsCancelled" INTEGER NOT NULL,
    "styleMemoriesDeleted" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "hardDeletedAt" TIMESTAMP(3),
    "hardDeleteSummary" JSONB,

    CONSTRAINT "business_purges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."publication_conversations" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "isLead" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publication_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."takedown_requests" (
    "id" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "requester" TEXT,
    "reference" TEXT,
    "organisationId" TEXT,
    "publicationId" TEXT,
    "summary" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "resolutionNote" TEXT,
    "enteredByUserId" TEXT NOT NULL,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "takedown_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."share_links" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."share_link_comments" (
    "id" TEXT NOT NULL,
    "shareLinkId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_link_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."usage_events" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending_setup',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."calendar_shadows" (
    "publicationId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "desiredOp" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "title" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending_setup',
    "coreEntryId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_shadows_pkey" PRIMARY KEY ("publicationId")
);

-- CreateIndex
CREATE UNIQUE INDEX "data_exports_activeKey_key" ON "studio"."data_exports"("activeKey");

-- CreateIndex
CREATE INDEX "data_exports_organisationId_createdAt_idx" ON "studio"."data_exports"("organisationId", "createdAt");

-- CreateIndex
CREATE INDEX "data_exports_state_expiresAt_idx" ON "studio"."data_exports"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "business_purges_state_graceUntil_idx" ON "studio"."business_purges"("state", "graceUntil");

-- CreateIndex
CREATE UNIQUE INDEX "business_purges_organisationId_businessId_key" ON "studio"."business_purges"("organisationId", "businessId");

-- CreateIndex
CREATE INDEX "publication_conversations_organisationId_receivedAt_idx" ON "studio"."publication_conversations"("organisationId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "publication_conversations_publicationId_conversationId_key" ON "studio"."publication_conversations"("publicationId", "conversationId");

-- CreateIndex
CREATE INDEX "takedown_requests_receivedAt_idx" ON "studio"."takedown_requests"("receivedAt");

-- CreateIndex
CREATE INDEX "takedown_requests_state_receivedAt_idx" ON "studio"."takedown_requests"("state", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "share_links_tokenHash_key" ON "studio"."share_links"("tokenHash");

-- CreateIndex
CREATE INDEX "share_links_organisationId_projectId_createdAt_idx" ON "studio"."share_links"("organisationId", "projectId", "createdAt");

-- CreateIndex
CREATE INDEX "share_link_comments_shareLinkId_createdAt_idx" ON "studio"."share_link_comments"("shareLinkId", "createdAt");

-- CreateIndex
CREATE INDEX "share_link_comments_projectId_createdAt_idx" ON "studio"."share_link_comments"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "usage_events_eventKey_key" ON "studio"."usage_events"("eventKey");

-- CreateIndex
CREATE INDEX "usage_events_state_occurredAt_idx" ON "studio"."usage_events"("state", "occurredAt");

-- CreateIndex
CREATE INDEX "usage_events_organisationId_occurredAt_idx" ON "studio"."usage_events"("organisationId", "occurredAt");

-- CreateIndex
CREATE INDEX "calendar_shadows_state_updatedAt_idx" ON "studio"."calendar_shadows"("state", "updatedAt");

-- CreateIndex
CREATE INDEX "calendar_shadows_organisationId_idx" ON "studio"."calendar_shadows"("organisationId");

-- AddForeignKey
ALTER TABLE "studio"."share_link_comments" ADD CONSTRAINT "share_link_comments_shareLinkId_fkey" FOREIGN KEY ("shareLinkId") REFERENCES "studio"."share_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

