-- 23.1 music reuse (operator request 2026-10-06): expand-only. One new platform-level table,
-- music_library_tracks: generated instrumental music beds keyed by prompt key + duration bucket,
-- reused across videos (pipeline/music-library.ts). No existing row or column changes.

-- CreateTable
CREATE TABLE "studio"."music_library_tracks" (
    "id" TEXT NOT NULL,
    "promptKey" TEXT NOT NULL,
    "bucketSec" INTEGER NOT NULL,
    "durationSec" DOUBLE PRECISION NOT NULL,
    "s3Bucket" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "providerJobId" TEXT,
    "costPence" INTEGER NOT NULL DEFAULT 0,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "music_library_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "music_library_tracks_promptKey_bucketSec_idx" ON "studio"."music_library_tracks"("promptKey", "bucketSec");

-- CreateIndex
CREATE UNIQUE INDEX "music_library_tracks_s3Bucket_s3Key_key" ON "studio"."music_library_tracks"("s3Bucket", "s3Key");
