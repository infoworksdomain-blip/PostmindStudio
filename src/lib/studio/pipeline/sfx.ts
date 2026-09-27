import { createHash } from 'node:crypto';
import { CostCapPausedError, KillSwitchTriggeredError, ProviderError } from '../../errors';
import { sfxKeywords } from '../providers/storyblocks-audio';
import type { PlanTier } from '../providers/router';
import type { PipelineDeps } from './deps';
import { DEFAULT_MUSIC_MIN_TIER, musicAllowedForTier } from './music';
import { mergeProjectMetadata } from './project-state';
import { runProvider } from './provider-run';

// BACKLOG 13.27 — Layer 5 sound effects (spec 5.6 "sound effects on transitions and hits").
// Layer 2 may give a shot an `sfxCue` (scripting.ts); here each distinct cue is resolved once per
// run to a Storyblocks SFX clip (providers/storyblocks-audio.ts), stored as an AUDIO_SFX asset,
// and laid under the narration at the start of its shot (edl.ts). Decisions (flag for review):
//   - Same plan-tier gate as music (STUDIO_MUSIC_MIN_TIER, default STANDARD): Basic renders
//     have no Layer 5 audio beyond narration.
//   - Non-fatal, like music: a cue with no match or a provider error leaves that shot without an
//     effect and is listed in metadata.sfx; the video still renders. A paused budget or an
//     engaged kill switch still stops the run.
//   - Reuse: an AUDIO_SFX asset of this project with the same cue key is reused (re-render,
//     retry), so a clip is never downloaded twice for a project.

export const MAX_SFX_SEC = 3;
const MAX_CUES_PER_RUN = 24;
const REASON_MAX = 200;

export interface SfxCueResult {
  cue: string;
  shotIds: string[];
  status: 'added' | 'no_match' | 'failed';
  assetId?: string;
  title?: string | null;
  durationSec?: number | null;
  reused?: boolean;
  reason?: string;
}

export interface SfxMetadata {
  status: 'added' | 'none' | 'off_for_plan' | 'unavailable' | 'failed';
  runId: string;
  cues: SfxCueResult[];
  reason?: string;
}

export interface SfxClip {
  bucket: string;
  key: string;
  durationSec: number | null;
}

interface SfxShot {
  id: string;
  sfxCue: string | null;
}

export function cueKey(cue: string): string {
  return `sfx:${createHash('sha256').update(sfxKeywords(cue)).digest('hex').slice(0, 32)}`;
}

/** Distinct cues (by normalised keywords) with the shots that use them, capped per run. */
export function groupCues(
  shots: SfxShot[],
): Array<{ cue: string; key: string; shotIds: string[] }> {
  const byKey = new Map<string, { cue: string; key: string; shotIds: string[] }>();
  for (const shot of shots) {
    const cue = shot.sfxCue?.trim();
    if (!cue || !sfxKeywords(cue)) continue;
    const key = cueKey(cue);
    const entry = byKey.get(key) ?? { cue, key, shotIds: [] };
    entry.shotIds.push(shot.id);
    byKey.set(key, entry);
  }
  return [...byKey.values()].slice(0, MAX_CUES_PER_RUN);
}

async function record(deps: PipelineDeps, projectId: string, sfx: SfxMetadata) {
  await mergeProjectMetadata(deps.db, { projectId, runId: sfx.runId, patch: { sfx } });
}

async function resolveCue(
  deps: PipelineDeps,
  input: { organisationId: string; projectId: string; planTier: PlanTier },
  cue: { cue: string; key: string },
): Promise<{ clip: SfxClip | null; result: Omit<SfxCueResult, 'shotIds'> }> {
  const existing = await deps.db.videoAsset.findFirst({
    where: {
      projectId: input.projectId,
      organisationId: input.organisationId,
      kind: 'AUDIO_SFX',
      fingerprint: cue.key,
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    return {
      clip: { bucket: existing.s3Bucket, key: existing.s3Key, durationSec: existing.durationSec },
      result: {
        cue: cue.cue,
        status: 'added',
        assetId: existing.id,
        title: (existing.metadata as { title?: string | null } | null)?.title ?? null,
        durationSec: existing.durationSec,
        reused: true,
      },
    };
  }
  const run = await runProvider(
    {
      need: { kind: 'capability', capability: 'sfx' },
      planTier: input.planTier,
      request: {
        capability: 'sfx',
        organisationId: input.organisationId,
        projectId: input.projectId,
        query: cue.cue,
        maxDurationSec: MAX_SFX_SEC,
      },
    },
    deps,
  );
  const meta = (run.output.metadata ?? {}) as {
    s3Bucket?: unknown;
    s3Key?: unknown;
    bytes?: unknown;
    durationSec?: unknown;
    title?: unknown;
    stockItemId?: unknown;
  };
  if (typeof meta.s3Bucket !== 'string' || typeof meta.s3Key !== 'string') {
    throw new ProviderError(run.decision.providerId, 'unknown', 'SFX had no stored file', false);
  }
  const durationSec = typeof meta.durationSec === 'number' ? meta.durationSec : null;
  const title = typeof meta.title === 'string' ? meta.title : null;
  const asset = await deps.db.videoAsset.create({
    data: {
      organisationId: input.organisationId,
      projectId: input.projectId,
      shotId: null,
      kind: 'AUDIO_SFX',
      source: `${run.decision.providerId}:${typeof meta.stockItemId === 'string' ? meta.stockItemId : 'unknown'}`,
      s3Bucket: meta.s3Bucket,
      s3Key: meta.s3Key,
      durationSec,
      fileSizeBytes: typeof meta.bytes === 'number' ? BigInt(meta.bytes) : null,
      fingerprint: cue.key,
      providerJobId: run.providerJobRowId,
      costPence: 0,
      metadata: { cue: cue.cue, title },
    },
  });
  return {
    clip: { bucket: asset.s3Bucket, key: asset.s3Key, durationSec },
    result: { cue: cue.cue, status: 'added', assetId: asset.id, title, durationSec, reused: false },
  };
}

function isNoMatch(err: unknown): boolean {
  return err instanceof ProviderError && err.errorClass === 'invalid_request';
}

/**
 * Resolve the run's SFX cues. Returns shotId → clip for the edit list. Never throws for SFX
 * problems; CostCapPausedError and KillSwitchTriggeredError propagate.
 */
export async function produceSfx(
  deps: PipelineDeps,
  input: {
    project: { id: string; organisationId: string };
    runId: string;
    planTier: PlanTier;
    shots: SfxShot[];
  },
): Promise<Map<string, SfxClip>> {
  const { project, runId, planTier } = input;
  const clips = new Map<string, SfxClip>();
  const cues = groupCues(input.shots);
  if (cues.length === 0) {
    await record(deps, project.id, { status: 'none', runId, cues: [] });
    return clips;
  }
  const minTier = deps.config.musicMinTier ?? DEFAULT_MUSIC_MIN_TIER;
  if (!musicAllowedForTier(planTier, minTier)) {
    await record(deps, project.id, { status: 'off_for_plan', runId, cues: [] });
    return clips;
  }
  if (deps.registry.getAdaptersByCapability('sfx').length === 0) {
    await record(deps, project.id, {
      status: 'unavailable',
      runId,
      cues: [],
      reason: 'no sound-effects provider configured (STORYBLOCKS_API_*_KEY)',
    });
    return clips;
  }
  const results: SfxCueResult[] = [];
  for (const cue of cues) {
    try {
      const { clip, result } = await resolveCue(
        deps,
        { organisationId: project.organisationId, projectId: project.id, planTier },
        cue,
      );
      if (clip) for (const shotId of cue.shotIds) clips.set(shotId, clip);
      results.push({ ...result, shotIds: cue.shotIds });
    } catch (err) {
      if (err instanceof CostCapPausedError || err instanceof KillSwitchTriggeredError) throw err;
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, REASON_MAX);
      deps.logger.warn({ projectId: project.id, cue: cue.cue, reason }, 'sfx cue skipped');
      results.push({
        cue: cue.cue,
        shotIds: cue.shotIds,
        status: isNoMatch(err) ? 'no_match' : 'failed',
        reason,
      });
    }
  }
  const added = results.some((r) => r.status === 'added');
  await record(deps, project.id, {
    status: added ? 'added' : 'failed',
    runId,
    cues: results,
  });
  return clips;
}
