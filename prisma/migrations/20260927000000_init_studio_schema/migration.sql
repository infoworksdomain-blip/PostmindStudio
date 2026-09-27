-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "studio";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "studio"."VideoProjectState" AS ENUM ('DRAFT', 'QUEUED', 'SCANNING', 'PLANNING', 'ASSETS_QUEUED', 'ASSETS_GENERATING', 'RENDERING', 'QUALITY_CHECKING', 'QUALITY_FAILED', 'READY_FOR_REVIEW', 'APPROVED', 'PUBLISHING', 'PUBLISHED', 'PARTIALLY_PUBLISHED', 'REJECTED', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "studio"."VideoSourceType" AS ENUM ('BRIEF', 'POSTMIND_CONTENT', 'TEMPLATE', 'UPLOAD', 'LIBRARY_REFERENCE', 'SLIDESHOW');

-- CreateEnum
CREATE TYPE "studio"."ReferenceMode" AS ENUM ('TEMPLATE', 'INSPIRE');

-- CreateEnum
CREATE TYPE "studio"."ReviewPolicy" AS ENUM ('AUTO_APPROVE', 'REQUIRE_APPROVAL', 'REQUIRE_APPROVAL_FROM_ROLE');

-- CreateEnum
CREATE TYPE "studio"."PublishPolicy" AS ENUM ('MANUAL', 'SCHEDULED', 'AUTO_ON_APPROVAL');

-- CreateEnum
CREATE TYPE "studio"."VisualTreatment" AS ENUM ('AI_CLIP', 'AI_AVATAR', 'STOCK_FOOTAGE', 'IMAGE_STILL', 'MOTION_GRAPHICS', 'USER_UPLOAD', 'TEXT_CARD', 'TRANSITION');

-- CreateEnum
CREATE TYPE "studio"."ShotState" AS ENUM ('PLANNED', 'QUEUED', 'GENERATING', 'READY', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "studio"."AssetKind" AS ENUM ('VIDEO_CLIP', 'IMAGE', 'AUDIO_VOICE', 'AUDIO_MUSIC', 'AUDIO_SFX');

-- CreateEnum
CREATE TYPE "studio"."QualityCheckState" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'FORCE_APPROVED');

-- CreateEnum
CREATE TYPE "studio"."PublicationState" AS ENUM ('SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED', 'TAKEN_DOWN');

-- CreateEnum
CREATE TYPE "studio"."ProviderJobState" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "studio"."StyleSignalType" AS ENUM ('SHOT_PACE', 'TREATMENT_MIX', 'PROVIDER_PREFERENCE', 'SCRIPT_STRUCTURE', 'POSTING_TIME');

-- CreateEnum
CREATE TYPE "studio"."ScheduleState" AS ENUM ('PENDING', 'FIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "studio"."ApprovalTaskState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "studio"."LicenseScenario" AS ENUM ('LICENSED', 'OWNED', 'SCRAPED');

-- CreateEnum
CREATE TYPE "studio"."PresetScope" AS ENUM ('BUILT_IN', 'ORG', 'BUSINESS');

-- CreateEnum
CREATE TYPE "studio"."SlideType" AS ENUM ('IMAGE_STILL', 'IMAGE_KENBURNS', 'VIDEO_CLIP', 'TEXT_CARD', 'BEFORE_AFTER', 'QUOTE', 'STATISTIC', 'PRODUCT');

-- CreateEnum
CREATE TYPE "studio"."ScanState" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "studio"."ImageSource" AS ENUM ('SCRAPED', 'STOCK', 'GENERATED', 'UPLOAD');

-- CreateTable
CREATE TABLE "studio"."video_projects" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "state" "studio"."VideoProjectState" NOT NULL,
    "sourceType" "studio"."VideoSourceType" NOT NULL,
    "sourceRef" TEXT,
    "referenceVideoId" TEXT,
    "referenceMode" "studio"."ReferenceMode",
    "targetFormats" JSONB NOT NULL,
    "brandKitId" TEXT,
    "templateId" TEXT,
    "costBudgetPence" INTEGER,
    "costActualPence" INTEGER NOT NULL DEFAULT 0,
    "costCurrency" TEXT NOT NULL DEFAULT 'GBP',
    "reviewPolicy" "studio"."ReviewPolicy" NOT NULL DEFAULT 'REQUIRE_APPROVAL',
    "publishPolicy" "studio"."PublishPolicy" NOT NULL DEFAULT 'MANUAL',
    "scheduledStartAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorReason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "video_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."video_briefs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "rawInput" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "keyMessage" TEXT NOT NULL,
    "targetAudience" TEXT NOT NULL,
    "tone" TEXT NOT NULL,
    "callToAction" TEXT,
    "keywords" JSONB NOT NULL,
    "ideationModel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."video_scripts" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "targetPlatform" TEXT NOT NULL,
    "targetAspectRatio" TEXT NOT NULL,
    "targetDurationSec" INTEGER NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en-GB',
    "fullText" TEXT NOT NULL,
    "scriptModel" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_scripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."video_shots" (
    "id" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "durationSec" DOUBLE PRECISION NOT NULL,
    "visualTreatment" "studio"."VisualTreatment" NOT NULL,
    "sceneDescription" TEXT NOT NULL,
    "cameraDirection" TEXT,
    "voiceoverText" TEXT,
    "onScreenText" TEXT,
    "transitionOut" TEXT,
    "providerRouting" JSONB,
    "assetId" TEXT,
    "voiceAssetId" TEXT,
    "state" "studio"."ShotState" NOT NULL,
    "errorReason" TEXT,

    CONSTRAINT "video_shots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."video_assets" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "shotId" TEXT,
    "kind" "studio"."AssetKind" NOT NULL,
    "source" TEXT NOT NULL,
    "s3Bucket" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "publicUrl" TEXT,
    "durationSec" DOUBLE PRECISION,
    "widthPx" INTEGER,
    "heightPx" INTEGER,
    "fileSizeBytes" BIGINT,
    "fingerprint" TEXT,
    "providerJobId" TEXT,
    "costPence" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."video_renders" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "targetPlatform" TEXT NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "durationSec" DOUBLE PRECISION NOT NULL,
    "fps" INTEGER NOT NULL,
    "bitrateKbps" INTEGER NOT NULL,
    "s3Bucket" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "publicUrl" TEXT,
    "thumbnailS3Key" TEXT,
    "captionsSrtS3Key" TEXT,
    "composerJobId" TEXT,
    "qualityCheckState" "studio"."QualityCheckState" NOT NULL,
    "qualityIssues" JSONB,
    "costPence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_renders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."video_publications" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "renderId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "platformAccountId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "platformPostId" TEXT,
    "platformUrl" TEXT,
    "state" "studio"."PublicationState" NOT NULL,
    "caption" TEXT,
    "hashtags" TEXT[],
    "errorReason" TEXT,
    "errorCode" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."video_analytics" (
    "id" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "bucketAt" TIMESTAMP(3) NOT NULL,
    "bucketSize" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "uniqueViewers" INTEGER,
    "watchTimeSec" INTEGER NOT NULL DEFAULT 0,
    "avgWatchTimePct" DOUBLE PRECISION,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "saves" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "retentionCurve" JSONB,
    "demographics" JSONB,

    CONSTRAINT "video_analytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."provider_jobs" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "projectId" TEXT,
    "provider" TEXT NOT NULL,
    "providerJobId" TEXT,
    "operation" TEXT NOT NULL,
    "requestBody" JSONB NOT NULL,
    "responseBody" JSONB,
    "state" "studio"."ProviderJobState" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "costPence" INTEGER NOT NULL DEFAULT 0,
    "errorClass" TEXT,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "provider_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."provider_usage" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "jobCount" INTEGER NOT NULL DEFAULT 0,
    "succeededCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "costPence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."brand_kits" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "businessProfileId" TEXT,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "logoAssetId" TEXT,
    "watermarkAssetId" TEXT,
    "colourPalette" JSONB NOT NULL,
    "fontPrimary" TEXT,
    "fontSecondary" TEXT,
    "toneKeywords" TEXT[],
    "audienceProfile" TEXT,
    "ctaTemplates" JSONB NOT NULL,
    "introCardAssetId" TEXT,
    "outroCardAssetId" TEXT,
    "voiceProfileId" TEXT,
    "restrictedTopics" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_kits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."voice_profiles" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerVoiceId" TEXT NOT NULL,
    "cloneSourceAssetId" TEXT,
    "languagesSupported" TEXT[],
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."style_memories" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "signalType" "studio"."StyleSignalType" NOT NULL,
    "value" JSONB NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "lastEvidenceAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "style_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."templates" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "targetFormats" JSONB NOT NULL,
    "scriptTemplate" TEXT NOT NULL,
    "shotBlueprint" JSONB NOT NULL,
    "brandKitHints" JSONB,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."scheduled_publications" (
    "id" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "state" "studio"."ScheduleState" NOT NULL,
    "jobId" TEXT,

    CONSTRAINT "scheduled_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."platform_connections" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "platformAccountId" TEXT NOT NULL,
    "platformAccountName" TEXT NOT NULL,
    "encryptedAccessToken" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "state" TEXT NOT NULL,
    "connectedByUserId" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."approval_workflows" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "appliesTo" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."approval_tasks" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workflowId" TEXT,
    "stepIndex" INTEGER NOT NULL,
    "requiredRole" TEXT NOT NULL,
    "state" "studio"."ApprovalTaskState" NOT NULL,
    "resolvedByUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "approval_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."system_flags" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "studio"."video_library" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "categoryId" TEXT NOT NULL,
    "tags" TEXT[],
    "sourceUrl" TEXT,
    "sourcePlatform" TEXT,
    "s3Bucket" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "thumbnailS3Key" TEXT NOT NULL,
    "durationSec" DOUBLE PRECISION NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "video_library_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."video_library_categories" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "depth" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_library_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."video_library_tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_library_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."video_library_analysis" (
    "id" TEXT NOT NULL,
    "libraryItemId" TEXT NOT NULL,
    "shotCount" INTEGER NOT NULL,
    "shots" JSONB NOT NULL,
    "transcript" JSONB NOT NULL,
    "overlayTimeline" JSONB NOT NULL,
    "musicEnvelope" JSONB NOT NULL,
    "hookPattern" TEXT NOT NULL,
    "structurePattern" TEXT NOT NULL,
    "ctaPattern" TEXT,
    "paceTag" TEXT NOT NULL,
    "moodTag" TEXT NOT NULL,
    "analysisVersion" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "video_library_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."video_library_embeddings" (
    "id" TEXT NOT NULL,
    "libraryItemId" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "visualWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.4,
    "audioWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "textWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.3,

    CONSTRAINT "video_library_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."video_library_licenses" (
    "id" TEXT NOT NULL,
    "libraryItemId" TEXT NOT NULL,
    "scenario" "studio"."LicenseScenario" NOT NULL,
    "licenseSource" TEXT,
    "licenseExpires" TIMESTAMP(3),
    "allowedModes" TEXT[],
    "notes" TEXT,

    CONSTRAINT "video_library_licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."text_overlays" (
    "id" TEXT NOT NULL,
    "shotId" TEXT,
    "renderId" TEXT,
    "presetId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "text" TEXT NOT NULL,
    "lang" TEXT NOT NULL DEFAULT 'en-GB',
    "startAtSec" DOUBLE PRECISION NOT NULL,
    "endAtSec" DOUBLE PRECISION NOT NULL,
    "animationInMs" INTEGER NOT NULL DEFAULT 400,
    "animationOutMs" INTEGER NOT NULL DEFAULT 400,
    "animationIn" TEXT NOT NULL,
    "animationOut" TEXT NOT NULL,
    "easing" TEXT NOT NULL DEFAULT 'easeInOut',
    "fontFamily" TEXT NOT NULL,
    "fontWeight" INTEGER NOT NULL DEFAULT 700,
    "fontSizePct" DOUBLE PRECISION NOT NULL,
    "fontItalic" BOOLEAN NOT NULL DEFAULT false,
    "letterSpacing" DOUBLE PRECISION,
    "lineHeight" DOUBLE PRECISION,
    "fillColor" TEXT NOT NULL,
    "strokeColor" TEXT,
    "strokeWidthPx" DOUBLE PRECISION,
    "shadowColor" TEXT,
    "shadowBlurPx" DOUBLE PRECISION,
    "shadowOffsetXPx" DOUBLE PRECISION,
    "shadowOffsetYPx" DOUBLE PRECISION,
    "backgroundType" TEXT NOT NULL DEFAULT 'none',
    "backgroundColor" TEXT,
    "backgroundPaddingPx" DOUBLE PRECISION,
    "backgroundRadiusPx" DOUBLE PRECISION,
    "anchorX" DOUBLE PRECISION NOT NULL,
    "anchorY" DOUBLE PRECISION NOT NULL,
    "alignment" TEXT NOT NULL DEFAULT 'center',
    "rotationDeg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "effect" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "text_overlays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."overlay_presets" (
    "id" TEXT NOT NULL,
    "scope" "studio"."PresetScope" NOT NULL,
    "organisationId" TEXT,
    "businessId" TEXT,
    "name" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "brandSubstitution" BOOLEAN NOT NULL DEFAULT true,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "overlay_presets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."slideshow_slides" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "slideType" "studio"."SlideType" NOT NULL,
    "imageAssetId" TEXT,
    "videoAssetId" TEXT,
    "backgroundColor" TEXT,
    "durationSec" DOUBLE PRECISION NOT NULL DEFAULT 2.5,
    "transitionIn" TEXT,
    "transitionOut" TEXT,
    "kenBurnsSpec" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slideshow_slides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."slideshow_templates" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "slidePlan" JSONB NOT NULL,
    "musicMood" TEXT,
    "defaultDurationPerSlide" DOUBLE PRECISION NOT NULL DEFAULT 2.5,
    "overlayDefaults" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slideshow_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."business_profiles" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "subNiche" TEXT NOT NULL,
    "products" TEXT[],
    "services" TEXT[],
    "audienceKeywords" TEXT[],
    "toneIndicators" TEXT[],
    "regions" TEXT[],
    "imageThemes" TEXT[],
    "imageSearchQueries" TEXT[],
    "restrictedTopics" TEXT[],
    "brandVoiceSummary" TEXT,
    "classifierModel" TEXT NOT NULL,
    "classifierVersion" INTEGER NOT NULL DEFAULT 1,
    "lastRefreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedByUser" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "business_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."website_scans" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "state" "studio"."ScanState" NOT NULL,
    "pagesCrawled" INTEGER NOT NULL DEFAULT 0,
    "imagesIngested" INTEGER NOT NULL DEFAULT 0,
    "errorReason" TEXT,
    "robotsBlocked" BOOLEAN NOT NULL DEFAULT false,
    "usedJsRender" BOOLEAN NOT NULL DEFAULT false,
    "costPence" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "website_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."image_library" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" "studio"."ImageSource" NOT NULL,
    "sourceUrl" TEXT,
    "sourceProvider" TEXT,
    "s3Bucket" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "publicUrl" TEXT,
    "widthPx" INTEGER NOT NULL,
    "heightPx" INTEGER NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "tags" TEXT[],
    "altText" TEXT,
    "fingerprint" TEXT NOT NULL,
    "generatedFromPrompt" TEXT,
    "embedding" vector(1536),
    "licenseNotes" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "image_library_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio"."image_library_queries" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "resultCount" INTEGER NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "image_library_queries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_projects_organisationId_state_idx" ON "studio"."video_projects"("organisationId", "state");

-- CreateIndex
CREATE INDEX "video_projects_businessId_createdAt_idx" ON "studio"."video_projects"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "video_briefs_projectId_key" ON "studio"."video_briefs"("projectId");

-- CreateIndex
CREATE INDEX "video_scripts_projectId_idx" ON "studio"."video_scripts"("projectId");

-- CreateIndex
CREATE INDEX "video_shots_scriptId_sortOrder_idx" ON "studio"."video_shots"("scriptId", "sortOrder");

-- CreateIndex
CREATE INDEX "video_assets_organisationId_fingerprint_idx" ON "studio"."video_assets"("organisationId", "fingerprint");

-- CreateIndex
CREATE INDEX "video_assets_projectId_idx" ON "studio"."video_assets"("projectId");

-- CreateIndex
CREATE INDEX "video_assets_shotId_idx" ON "studio"."video_assets"("shotId");

-- CreateIndex
CREATE INDEX "video_renders_projectId_idx" ON "studio"."video_renders"("projectId");

-- CreateIndex
CREATE INDEX "video_publications_organisationId_publishedAt_idx" ON "studio"."video_publications"("organisationId", "publishedAt");

-- CreateIndex
CREATE INDEX "video_publications_state_scheduledFor_idx" ON "studio"."video_publications"("state", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "video_publications_platform_platformPostId_key" ON "studio"."video_publications"("platform", "platformPostId");

-- CreateIndex
CREATE INDEX "video_analytics_publicationId_bucketAt_idx" ON "studio"."video_analytics"("publicationId", "bucketAt");

-- CreateIndex
CREATE UNIQUE INDEX "video_analytics_publicationId_bucketAt_bucketSize_key" ON "studio"."video_analytics"("publicationId", "bucketAt", "bucketSize");

-- CreateIndex
CREATE INDEX "provider_jobs_organisationId_provider_startedAt_idx" ON "studio"."provider_jobs"("organisationId", "provider", "startedAt");

-- CreateIndex
CREATE INDEX "provider_jobs_provider_state_idx" ON "studio"."provider_jobs"("provider", "state");

-- CreateIndex
CREATE INDEX "provider_usage_provider_day_idx" ON "studio"."provider_usage"("provider", "day");

-- CreateIndex
CREATE UNIQUE INDEX "provider_usage_organisationId_provider_day_key" ON "studio"."provider_usage"("organisationId", "provider", "day");

-- CreateIndex
CREATE INDEX "brand_kits_organisationId_businessId_idx" ON "studio"."brand_kits"("organisationId", "businessId");

-- CreateIndex
CREATE UNIQUE INDEX "style_memories_organisationId_businessId_signalType_key" ON "studio"."style_memories"("organisationId", "businessId", "signalType");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_publications_publicationId_key" ON "studio"."scheduled_publications"("publicationId");

-- CreateIndex
CREATE INDEX "scheduled_publications_scheduledFor_state_idx" ON "studio"."scheduled_publications"("scheduledFor", "state");

-- CreateIndex
CREATE UNIQUE INDEX "platform_connections_organisationId_platform_platformAccoun_key" ON "studio"."platform_connections"("organisationId", "platform", "platformAccountId");

-- CreateIndex
CREATE INDEX "approval_tasks_projectId_stepIndex_idx" ON "studio"."approval_tasks"("projectId", "stepIndex");

-- CreateIndex
CREATE INDEX "video_library_categoryId_retiredAt_idx" ON "studio"."video_library"("categoryId", "retiredAt");

-- CreateIndex
CREATE INDEX "video_library_tags_idx" ON "studio"."video_library" USING GIN ("tags");

-- CreateIndex
CREATE UNIQUE INDEX "video_library_categories_slug_key" ON "studio"."video_library_categories"("slug");

-- CreateIndex
CREATE INDEX "video_library_categories_parentId_sortOrder_idx" ON "studio"."video_library_categories"("parentId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "video_library_tags_name_key" ON "studio"."video_library_tags"("name");

-- CreateIndex
CREATE UNIQUE INDEX "video_library_analysis_libraryItemId_key" ON "studio"."video_library_analysis"("libraryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "video_library_embeddings_libraryItemId_key" ON "studio"."video_library_embeddings"("libraryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "video_library_licenses_libraryItemId_key" ON "studio"."video_library_licenses"("libraryItemId");

-- CreateIndex
CREATE INDEX "text_overlays_shotId_idx" ON "studio"."text_overlays"("shotId");

-- CreateIndex
CREATE INDEX "text_overlays_renderId_idx" ON "studio"."text_overlays"("renderId");

-- CreateIndex
CREATE INDEX "overlay_presets_scope_group_idx" ON "studio"."overlay_presets"("scope", "group");

-- CreateIndex
CREATE INDEX "overlay_presets_organisationId_idx" ON "studio"."overlay_presets"("organisationId");

-- CreateIndex
CREATE INDEX "slideshow_slides_projectId_sortOrder_idx" ON "studio"."slideshow_slides"("projectId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "business_profiles_businessId_key" ON "studio"."business_profiles"("businessId");

-- CreateIndex
CREATE INDEX "website_scans_businessId_startedAt_idx" ON "studio"."website_scans"("businessId", "startedAt");

-- CreateIndex
CREATE INDEX "image_library_businessId_source_idx" ON "studio"."image_library"("businessId", "source");

-- CreateIndex
CREATE INDEX "image_library_tags_idx" ON "studio"."image_library" USING GIN ("tags");

-- CreateIndex
CREATE UNIQUE INDEX "image_library_businessId_fingerprint_key" ON "studio"."image_library"("businessId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "image_library_queries_businessId_provider_query_key" ON "studio"."image_library_queries"("businessId", "provider", "query");

-- AddForeignKey
ALTER TABLE "studio"."video_briefs" ADD CONSTRAINT "video_briefs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "studio"."video_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."video_scripts" ADD CONSTRAINT "video_scripts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "studio"."video_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."video_shots" ADD CONSTRAINT "video_shots_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "studio"."video_scripts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."video_renders" ADD CONSTRAINT "video_renders_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "studio"."video_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."video_publications" ADD CONSTRAINT "video_publications_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "studio"."video_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."video_publications" ADD CONSTRAINT "video_publications_renderId_fkey" FOREIGN KEY ("renderId") REFERENCES "studio"."video_renders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."video_analytics" ADD CONSTRAINT "video_analytics_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "studio"."video_publications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."approval_tasks" ADD CONSTRAINT "approval_tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "studio"."video_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."video_library" ADD CONSTRAINT "video_library_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "studio"."video_library_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."video_library_categories" ADD CONSTRAINT "video_library_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "studio"."video_library_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."video_library_analysis" ADD CONSTRAINT "video_library_analysis_libraryItemId_fkey" FOREIGN KEY ("libraryItemId") REFERENCES "studio"."video_library"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."video_library_embeddings" ADD CONSTRAINT "video_library_embeddings_libraryItemId_fkey" FOREIGN KEY ("libraryItemId") REFERENCES "studio"."video_library"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."video_library_licenses" ADD CONSTRAINT "video_library_licenses_libraryItemId_fkey" FOREIGN KEY ("libraryItemId") REFERENCES "studio"."video_library"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio"."text_overlays" ADD CONSTRAINT "text_overlays_shotId_fkey" FOREIGN KEY ("shotId") REFERENCES "studio"."video_shots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
