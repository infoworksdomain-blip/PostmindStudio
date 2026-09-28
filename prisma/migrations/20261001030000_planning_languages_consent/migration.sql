-- Phase 15 Track C (expand-only).
-- 15.C5: the video's language (BCP 47); scripts copy it (video_scripts.language already exists).
ALTER TABLE "studio"."video_projects" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'en-GB';

-- 15.C7: automatic consent-phrase check on voice clones.
ALTER TABLE "studio"."voice_profiles" ADD COLUMN "consentCheck" TEXT;
ALTER TABLE "studio"."voice_profiles" ADD COLUMN "consentTranscript" TEXT;
ALTER TABLE "studio"."voice_profiles" ADD COLUMN "consentCheckedAt" TIMESTAMP(3);
ALTER TABLE "studio"."voice_profiles" ADD COLUMN "providerVerificationRequired" BOOLEAN NOT NULL DEFAULT false;
