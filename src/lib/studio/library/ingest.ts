import { createHash, randomUUID } from 'node:crypto';
import type { LicenseScenario, Prisma } from '@prisma/client';
import { z } from 'zod';
import { ConfigurationError, NoProviderAvailableError, ValidationError } from '../../errors';
import { vectorLiteral } from '../images/ingest';
import type { PipelineDeps } from '../pipeline/deps';
import { jsonOutput, runProvider } from '../pipeline/provider-run';
import type { PlanTier } from '../providers/router';
import { safeGet } from '../scan/safe-fetch';
import { assertAllowedS3Source, isS3Url, isSupportedSourceUrl, parseS3Url } from './corpus-source';
import { openSourceStream, tap } from './source-stream';
import { vectorSql } from '../vector-sql';
import {
  ANALYSIS_SCHEMA,
  ANALYSIS_SYSTEM_PROMPT,
  buildAnalysisPrompt,
  energyTag,
  nearestAspectRatio,
  parseAnalysis,
  shotsFromSceneChanges,
  type ShotTiming,
  type VideoAnalysis,
} from './analyse';

// BACKLOG 9.1 / Addendum A3.3 — ingest one reference video:
//  1 store the source (SSRF-guarded download → studio-library-assets, keyed by content hash)
//  2 visual structure: ffprobe + FFmpeg scene detection → shots; one keyframe per shot
//  3 audio: AssemblyAI transcript with word timings; loudness → energy
//  4+5 on-screen text and structure: Claude reads the keyframes + transcript (analyse.ts)
//  6 embedding of the analysed description (the A7.4 schema stores one 1536-d text vector)
//  7 category from the analysis (or the curator's), 8 ready for search.
// Not built (no provider in the stack): BPM/key detection (librosa/Essentia) and visual/audio
// embeddings (CLIP/CLAP) — see the Phase 9 review list.

export const MAX_SOURCE_BYTES = 200 * 1024 * 1024;
/** A3.10: users only ever see this rendition (low-res, muted, 30s), never the source. */
export const PREVIEW_WIDTH = 360;
export const PREVIEW_MAX_SEC = 30;

/** Key of an item's preview rendition, derived from its source key. */
export function previewKey(s3Key: string): string {
  return s3Key.replace(/\.mp4$/, '-preview.mp4');
}
export const MAX_KEYFRAMES = 12;
export const SCENE_THRESHOLD = 0.3;
const KEYFRAME_WIDTH = 480;
const PLATFORM_ORG = 'postmind-platform';

/**
 * A3.2 scenarios: LICENSED (1), OWNED (2), SCRAPED (3), plus NOT_REQUIRED — operator decision
 * 2026-09-27: the 50k corpus is operator-owned content that needs no licence.
 */
export const LICENSE_SCENARIOS = ['LICENSED', 'OWNED', 'SCRAPED', 'NOT_REQUIRED'] as const;

/** Recorded as licenseSource when a NOT_REQUIRED item arrives without one (audit trail). */
export const NOT_REQUIRED_DEFAULT_SOURCE =
  'Operator decision 2026-09-27: no licence required for the PostMind corpus';

export const ingestItemInput = z.object({
  /** https:// (SSRF-guarded download) or s3://bucket/key in STUDIO_CORPUS_S3_BUCKETS. */
  sourceUrl: z
    .string()
    .trim()
    .max(2_000)
    .refine(isSupportedSourceUrl, { message: 'sourceUrl must be an http(s):// or s3:// URL' }),
  licenseScenario: z.enum(LICENSE_SCENARIOS),
  licenseSource: z.string().trim().max(500).optional(),
  licenseExpires: z.iso.datetime().optional(),
  category: z.string().trim().max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  title: z.string().trim().max(200).optional(),
  sourcePlatform: z.string().trim().max(40).optional(),
  /** The corpus manifest's own id for the row (tracking only; see video_library_ingest_runs). */
  sourceRef: z.string().trim().max(200).optional(),
  /** BCP 47-ish language tag of the video's speech/text (tracking only). */
  language: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'language must be a code such as en or pt-BR')
    .optional(),
});
export type IngestItem = z.infer<typeof ingestItemInput>;

/**
 * A3.1: TEMPLATE mode is disabled under scenario 3 (SCRAPED). LICENSED, OWNED and NOT_REQUIRED
 * allow both modes (expiry is still enforced by blueprint.assertModeAllowed).
 */
export function allowedModes(scenario: LicenseScenario): string[] {
  return scenario === 'SCRAPED' ? ['INSPIRE'] : ['TEMPLATE', 'INSPIRE'];
}

/** licenseSource to store: NOT_REQUIRED always records who decided and when. */
export function licenseSourceFor(
  scenario: LicenseScenario,
  licenseSource: string | null | undefined,
): string | null {
  if (licenseSource) return licenseSource;
  return scenario === 'NOT_REQUIRED' ? NOT_REQUIRED_DEFAULT_SOURCE : null;
}

/** Downloaded (or read) source bytes, capped at MAX_SOURCE_BYTES. */
export async function readSource(deps: PipelineDeps, sourceUrl: string): Promise<Uint8Array> {
  if (isS3Url(sourceUrl)) {
    // Allow-listed corpus bucket only, read with Studio's storage client (no HTTP fetch).
    const source = parseS3Url(sourceUrl);
    assertAllowedS3Source(source, deps.config.corpusS3Buckets ?? []);
    const size = await deps.storage.size(source.bucket, source.key);
    if (size > MAX_SOURCE_BYTES) throw new ValidationError('Source video is larger than 200 MB');
    if (size <= 0) throw new ValidationError('Source object is empty');
    return deps.storage.readRange(source.bucket, source.key, 0, size - 1);
  }
  const res = await safeGet(sourceUrl, {
    fetchImpl: deps.scan.pageFetch,
    userAgent: 'PostMindStudio/1.0 (+https://studio.postmind.ai/bot)',
    timeoutMs: 10 * 60_000,
    maxBytes: MAX_SOURCE_BYTES + 1,
    accept: 'video/*',
  });
  if (res.status >= 400) throw new ValidationError(`Source returned HTTP ${res.status}`);
  if (res.truncated) throw new ValidationError('Source video is larger than 200 MB');
  return res.body;
}

/**
 * Stores the source under its content hash (`library/<sha256>.mp4`). With a streaming-capable
 * storage (S3: multipart upload, 13.15) the bytes go to a staging key while being hashed, then
 * are copied to the final key; memory stays at one 8 MiB part. Otherwise they are buffered.
 * A source whose hash is already in the library is not stored twice.
 */
async function storeSource(
  deps: PipelineDeps,
  bucket: string,
  sourceUrl: string,
): Promise<{ existingId: string } | { hash: string; s3Key: string }> {
  const findExisting = (s3Key: string) =>
    deps.db.videoLibraryItem.findFirst({
      where: { s3Bucket: bucket, s3Key },
      select: { id: true },
    });
  const { putStream, copy } = deps.storage;
  if (!putStream || !copy) {
    const body = await readSource(deps, sourceUrl);
    const hash = createHash('sha256').update(body).digest('hex');
    const s3Key = `library/${hash}.mp4`;
    const existing = await findExisting(s3Key);
    if (existing) return { existingId: existing.id };
    await deps.storage.put({ bucket, key: s3Key, body, contentType: 'video/mp4' });
    return { hash, s3Key };
  }
  const hasher = createHash('sha256');
  const staging = `library/staging/${randomUUID()}.mp4`;
  const source = await openSourceStream(deps, sourceUrl, MAX_SOURCE_BYTES);
  await putStream.call(deps.storage, {
    bucket,
    key: staging,
    body: tap(source, (chunk) => hasher.update(chunk)),
    contentType: 'video/mp4',
  });
  try {
    const hash = hasher.digest('hex');
    const s3Key = `library/${hash}.mp4`;
    const existing = await findExisting(s3Key);
    if (existing) return { existingId: existing.id };
    await copy.call(deps.storage, bucket, staging, s3Key);
    return { hash, s3Key };
  } finally {
    await deps.storage.delete(bucket, staging).catch(() => undefined);
  }
}

export function embeddingDocument(input: {
  title: string;
  description: string;
  tags: string[];
  analysis: VideoAnalysis;
  transcript: string;
}): string {
  const a = input.analysis;
  return [
    input.title,
    input.description,
    `Tags: ${input.tags.join(', ')}`,
    `Hook: ${a.hookPattern}. Structure: ${a.structurePattern}. CTA: ${a.ctaPattern || 'none'}.`,
    `Pace: ${a.paceTag}. Mood: ${a.moodTag}. Genre: ${a.genreTag}. Music: ${a.musicMoodTag}.`,
    `Shots: ${a.shots.map((s) => `${s.type} (${s.description})`).join('; ')}`,
    input.transcript ? `Transcript: ${input.transcript.slice(0, 2_000)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 8_000);
}

async function transcribe(
  deps: PipelineDeps,
  mediaUrl: string,
  durationSec: number,
  planTier: PlanTier,
): Promise<{ text: string; words: unknown[]; skipped?: string }> {
  try {
    const run = await runProvider(
      {
        need: { kind: 'capability', capability: 'transcription' },
        planTier,
        request: {
          capability: 'transcription',
          organisationId: PLATFORM_ORG,
          mediaUrl,
          durationSec,
        },
      },
      deps,
    );
    const m = run.output.metadata as { text?: string; words?: unknown[] };
    return { text: m.text ?? '', words: m.words ?? [] };
  } catch (err) {
    // No transcription provider configured: index without speech rather than fail the corpus.
    if (err instanceof NoProviderAvailableError) {
      return { text: '', words: [], skipped: 'no transcription provider available' };
    }
    throw err;
  }
}

async function keyframes(
  deps: PipelineDeps,
  url: string,
  shots: ShotTiming[],
): Promise<Array<{ mediaType: 'image/jpeg'; data: string }>> {
  // Evenly pick at most MAX_KEYFRAMES shots, frame from each shot's middle.
  const step = Math.max(1, shots.length / MAX_KEYFRAMES);
  const picks = new Set<number>();
  for (let i = 0; i < shots.length && picks.size < MAX_KEYFRAMES; i += step)
    picks.add(Math.floor(i));
  const frames = [];
  for (const index of picks) {
    const s = shots[index] as ShotTiming;
    const bytes = await deps.media.frameJpeg(url, (s.startSec + s.endSec) / 2, KEYFRAME_WIDTH);
    frames.push({ mediaType: 'image/jpeg' as const, data: Buffer.from(bytes).toString('base64') });
  }
  return frames;
}

/** Leaf-first category slugs offered to the analysis prompt. */
async function categorySlugs(deps: PipelineDeps): Promise<Map<string, string>> {
  const rows = await deps.db.videoLibraryCategory.findMany({ select: { id: true, slug: true } });
  return new Map(rows.map((r) => [r.slug, r.id]));
}

/** Step 2 — visual structure of a stored source: probe, scene-detected shots, keyframes. */
export async function visualStructure(deps: PipelineDeps, url: string) {
  const probe = await deps.media.probe(url);
  if (!(probe.durationSec > 0)) throw new ValidationError('Source has no video duration');
  const shots = shotsFromSceneChanges(
    await deps.media.sceneChanges(url, SCENE_THRESHOLD),
    probe.durationSec,
  );
  const frames = await keyframes(deps, url, shots);
  const analysedShots = frames.length < shots.length ? mergeToFrames(shots, frames.length) : shots;
  return { probe, frames, analysedShots };
}

type Visual = Awaited<ReturnType<typeof visualStructure>>;

/** Steps 3–5 + 7 — transcript, loudness, then Claude's structure/text/category analysis. */
export async function analyseContent(
  deps: PipelineDeps,
  input: {
    url: string;
    visual: Visual;
    planTier: PlanTier;
    hints: { title?: string; tags: string[] };
  },
) {
  const { url, visual, planTier } = input;
  // 3 — audio
  const transcript = await transcribe(deps, url, visual.probe.durationSec, planTier);
  const loudness = await deps.media.integratedLoudness(url);

  // 4+5+7 — structure, on-screen text and category (Claude with keyframes)
  const categories = await categorySlugs(deps);
  const run = await runProvider(
    {
      need: { kind: 'capability', capability: 'text_generation' },
      planTier,
      request: {
        capability: 'text_generation',
        organisationId: PLATFORM_ORG,
        system: ANALYSIS_SYSTEM_PROMPT,
        prompt: buildAnalysisPrompt({
          durationSec: visual.probe.durationSec,
          shots: visual.analysedShots,
          transcript: transcript.text,
          categorySlugs: [...categories.keys()],
          hints: input.hints,
        }),
        images: visual.frames,
        maxTokens: 4_000,
        outputSchema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
      },
    },
    deps,
  );
  const analysis = parseAnalysis(jsonOutput(run.output), visual.analysedShots.length);
  const shotRows = visual.analysedShots.map((s, i) => ({ ...s, ...analysis.shots[i] }));
  const overlayTimeline = shotRows
    .filter((s) => s.onScreenText)
    .map((s) => ({
      startSec: s.startSec,
      endSec: s.endSec,
      text: s.onScreenText,
      style: s.overlayStyle,
    }));
  /** video_library_analysis columns (without libraryItemId). */
  const analysisRow = {
    shotCount: shotRows.length,
    shots: shotRows as unknown as Prisma.InputJsonValue,
    transcript: {
      text: transcript.text,
      words: transcript.words,
      ...(transcript.skipped && { skipped: transcript.skipped }),
    } as Prisma.InputJsonValue,
    overlayTimeline: overlayTimeline as Prisma.InputJsonValue,
    musicEnvelope: {
      bpm: null,
      key: null,
      energy: energyTag(loudness),
      integratedLufs: loudness,
      mood: analysis.musicMoodTag,
      genre: analysis.genreTag,
    } as Prisma.InputJsonValue,
    hookPattern: analysis.hookPattern,
    structurePattern: analysis.structurePattern,
    ctaPattern: analysis.ctaPattern || null,
    paceTag: analysis.paceTag,
    moodTag: analysis.moodTag,
  };
  const suggestedCategoryId = analysis.categorySlugs.map((s) => categories.get(s)).find(Boolean);
  return { analysis, transcript, categories, suggestedCategoryId, analysisRow };
}

/** Step 6 — embed the analysed description and store it (replacing any previous vector). */
export async function storeLibraryEmbedding(
  deps: PipelineDeps,
  libraryItemId: string,
  document: string,
  planTier: PlanTier,
  replace = false,
): Promise<void> {
  const embed = await runProvider(
    {
      need: { kind: 'capability', capability: 'embedding' },
      planTier,
      request: {
        capability: 'embedding',
        organisationId: PLATFORM_ORG,
        input: [document],
        dimensions: 1536,
      },
    },
    deps,
  );
  const vector = (embed.output.metadata as { embeddings?: number[][] }).embeddings?.[0];
  if (!vector || vector.length !== 1536) throw new ValidationError('Embedding had the wrong shape');
  const v = await vectorSql(deps.db);
  const model = `${embed.decision.adapter.providerId}:text-embedding`;
  if (replace) {
    await deps.db.$transaction([
      deps.db.$executeRaw`DELETE FROM studio.video_library_embeddings WHERE "libraryItemId" = ${libraryItemId}`,
      deps.db.$executeRaw`INSERT INTO studio.video_library_embeddings
        (id, "libraryItemId", embedding, "embeddingModel")
        VALUES (${randomUUID()}, ${libraryItemId}, ${vectorLiteral(vector)}${v.cast}, ${model})`,
    ]);
    return;
  }
  await deps.db.$executeRaw`INSERT INTO studio.video_library_embeddings
    (id, "libraryItemId", embedding, "embeddingModel")
    VALUES (${randomUUID()}, ${libraryItemId}, ${vectorLiteral(vector)}${v.cast}, ${model})`;
}

export async function ingestLibraryVideo(
  deps: PipelineDeps,
  item: IngestItem,
  planTier: PlanTier,
): Promise<{ libraryItemId: string; created: boolean }> {
  const bucket = deps.config.libraryBucket;
  if (!bucket) throw new ConfigurationError('S3_BUCKET_LIBRARY is required for library ingestion');

  // 1 — store the source
  const stored = await storeSource(deps, bucket, item.sourceUrl);
  if ('existingId' in stored) return { libraryItemId: stored.existingId, created: false };
  const { hash, s3Key } = stored;
  const url = await deps.storage.signedUrl(bucket, s3Key, 6 * 60 * 60);

  // 2 — visual structure
  const visual = await visualStructure(deps, url);
  const { probe } = visual;
  const thumbnail = await deps.media.frameJpeg(
    url,
    Math.min(1, probe.durationSec / 2),
    KEYFRAME_WIDTH,
  );
  const thumbnailS3Key = `library/${hash}-thumb.jpg`;
  await deps.storage.put({
    bucket,
    key: thumbnailS3Key,
    body: thumbnail,
    contentType: 'image/jpeg',
  });
  await deps.storage.put({
    bucket,
    key: previewKey(s3Key),
    body: await deps.media.previewClip(url, PREVIEW_WIDTH, PREVIEW_MAX_SEC),
    contentType: 'video/mp4',
  });

  // 3–5 + 7 — audio, structure, on-screen text and category
  const content = await analyseContent(deps, {
    url,
    visual,
    planTier,
    hints: { title: item.title, tags: item.tags },
  });
  const { analysis, transcript } = content;
  const categoryId =
    (item.category && content.categories.get(item.category)) || content.suggestedCategoryId;
  if (!categoryId)
    throw new ValidationError('No valid category for this video (seed the taxonomy)');

  const title = item.title || analysis.title;
  const tags = [...new Set([...item.tags.map((t) => t.toLowerCase()), ...analysis.tags])].slice(
    0,
    20,
  );

  const libraryItemId = await deps.db.$transaction(async (tx) => {
    const created = await tx.videoLibraryItem.create({
      data: {
        title,
        description: analysis.description,
        categoryId,
        tags,
        sourceUrl: item.sourceUrl,
        sourcePlatform: item.sourcePlatform ?? null,
        s3Bucket: bucket,
        s3Key,
        thumbnailS3Key,
        durationSec: probe.durationSec,
        aspectRatio: nearestAspectRatio(probe.width, probe.height),
      },
    });
    await tx.videoLibraryAnalysis.create({
      data: { libraryItemId: created.id, ...content.analysisRow },
    });
    await tx.videoLibraryLicense.create({
      data: {
        libraryItemId: created.id,
        scenario: item.licenseScenario,
        licenseSource: licenseSourceFor(item.licenseScenario, item.licenseSource),
        licenseExpires: item.licenseExpires ? new Date(item.licenseExpires) : null,
        allowedModes: allowedModes(item.licenseScenario),
      },
    });
    for (const name of tags) {
      await tx.videoLibraryTag.upsert({
        where: { name },
        create: { name, usageCount: 1 },
        update: { usageCount: { increment: 1 } },
      });
    }
    return created.id;
  });

  // 6 — embedding
  await storeLibraryEmbedding(
    deps,
    libraryItemId,
    embeddingDocument({
      title,
      description: analysis.description,
      tags,
      analysis,
      transcript: transcript.text,
    }),
    planTier,
  );
  return { libraryItemId, created: true };
}

/** When there are more shots than keyframes, group neighbouring shots so each has one frame. */
export function mergeToFrames(shots: ShotTiming[], frameCount: number): ShotTiming[] {
  if (frameCount <= 0) return shots.slice(0, 1);
  const size = shots.length / frameCount;
  const out: ShotTiming[] = [];
  for (let i = 0; i < frameCount; i += 1) {
    const group = shots.slice(Math.floor(i * size), Math.floor((i + 1) * size));
    const first = group[0];
    const last = group.at(-1);
    if (first && last) out.push({ startSec: first.startSec, endSec: last.endSec });
  }
  return out;
}

export { PLATFORM_ORG };
