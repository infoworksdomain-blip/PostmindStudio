import type { Prisma, VideoAsset, VisualTreatment } from '@prisma/client';
import type { PipelineDeps } from './deps';
import { scriptGrowBudgetSec } from './narration-fit';
import { currentRunId, mergeProjectMetadata } from './project-state';
import {
  MIN_DISPLAY_SEC,
  rebalanceShots,
  type RebalanceLengthened,
  type RebalancePlan,
  type RebalanceShot,
} from './shot-rebalance';
import { fitOf, type FitDecision } from './voice-fit';

// BACKLOG 21.1 — apply the rebalance (shot-rebalance.ts) at the start of composition, when every
// shot of the run is terminal and its narration measured (voice fit runs per shot, in parallel,
// so no single shot job can see the whole script). For each script:
//   1. read its shots, their overlays, narration fits and visuals; probe the stored clip of a
//      trimmed video shot (a provider clip is usually longer than the shot it was made for);
//   2. plan the new lengths (pure, deterministic);
//   3. in one transaction: write the new shot lengths (the EDL, captions, SRT and quality checks
//      all read video_shots.durationSec), move the end of overlays that run to a shot's end with
//      it, and record the lengthened shot's narration as fit "rebalance" (no trimSec: the
//      composer plays the voice clip whole, and captions show every word);
// then record the narration that is still shortened in project.metadata.narrationShortened for
// the review screen (the quality gate's audio_sync check also reports it as a warning).
// Idempotent: a retried compose finds no trimmed shot that can still be helped.

/** An overlay ending within this of the shot end "runs to the end" and follows a new end. */
const END_TIED_SEC = 0.01;
/** Treatments whose length is the owner's own footage: never shortened to give time away. */
const NEVER_DONATE: ReadonlySet<VisualTreatment> = new Set<VisualTreatment>(['USER_UPLOAD']);
const CARD_TREATMENTS: ReadonlySet<VisualTreatment> = new Set<VisualTreatment>([
  'TEXT_CARD',
  'MOTION_GRAPHICS',
]);

export interface OverlayTiming {
  id: string;
  startAtSec: number;
  endAtSec: number;
}

export interface NarrationShortened {
  scriptId: string;
  platform: string;
  shotId: string;
  /** 1-based position of the shot in its script (what the review screen calls "shot N"). */
  shotNumber: number;
  voiceSec: number | null;
  /** Seconds of narration the viewer hears. */
  keptSec: number;
  boundary: 'sentence' | 'word' | 'none';
  droppedWords: number;
}

const tiedToEnd = (o: OverlayTiming, durationSec: number) =>
  o.endAtSec >= durationSec - END_TIED_SEC;

/**
 * Seconds a shot must keep for its overlays: an overlay that ends inside the shot is never cut,
 * and one that runs to the shot end keeps at least MIN_DISPLAY_SEC on screen.
 */
export function overlayHoldSec(overlays: readonly OverlayTiming[], durationSec: number): number {
  return overlays.reduce(
    (hold, o) =>
      Math.max(
        hold,
        tiedToEnd(o, durationSec)
          ? Math.min(durationSec, o.startAtSec + MIN_DISPLAY_SEC)
          : o.endAtSec,
      ),
    0,
  );
}

/** Overlays whose end moves with the shot's new end (those that ran to the old end). */
export function retimedOverlays(
  overlays: readonly OverlayTiming[],
  fromSec: number,
  toSec: number,
): Array<{ id: string; endAtSec: number }> {
  return overlays
    .filter((o) => tiedToEnd(o, fromSec) || o.endAtSec > toSec)
    .map((o) => ({ id: o.id, endAtSec: toSec }));
}

function wordCount(text: string | null | undefined): number {
  return (text ?? '').split(/\s+/).filter(Boolean).length;
}

interface ScriptShot {
  id: string;
  sortOrder: number;
  durationSec: number;
  visualTreatment: VisualTreatment;
  assetId: string | null;
  voiceAssetId: string | null;
  onScreenText: string | null;
  voiceoverText: string | null;
  overlays: OverlayTiming[];
}

/** The longest the shot's picture can play (see RebalanceShot.maxVisualSec). */
async function maxVisualSec(
  deps: PipelineDeps,
  visual: VideoAsset | undefined,
  needed: boolean,
): Promise<number | null> {
  // No visual (text and motion cards; a missing still renders as a card, edl.ts) or an image.
  if (!visual || visual.kind === 'IMAGE') return Number.POSITIVE_INFINITY;
  if (!needed) return null;
  try {
    const probed = await deps.media.probe(
      await deps.storage.signedUrl(visual.s3Bucket, visual.s3Key),
    );
    if (probed.durationSec > 0) return probed.durationSec;
  } catch (err) {
    deps.logger.warn(
      { err: (err as Error).message, assetId: visual.id },
      'clip length could not be probed; using its recorded length',
    );
  }
  // The recorded length is what was asked of the provider: a safe lower bound.
  return visual.durationSec ?? null;
}

async function rebalanceInput(
  deps: PipelineDeps,
  shots: readonly ScriptShot[],
  assets: ReadonlyMap<string, VideoAsset>,
): Promise<RebalanceShot[]> {
  return Promise.all(
    shots.map(async (shot) => {
      const fit = shot.voiceAssetId ? fitOf(assets.get(shot.voiceAssetId)?.metadata ?? null) : null;
      // metadata.fit is stored JSON: only a finite number counts as a measurement.
      const voiceSec =
        typeof fit?.voiceSec === 'number' && Number.isFinite(fit.voiceSec) ? fit.voiceSec : null;
      const trimmed = fit?.strategy === 'trim' && voiceSec !== null;
      const card = CARD_TREATMENTS.has(shot.visualTreatment);
      return {
        id: shot.id,
        durationSec: shot.durationSec,
        voiceSec,
        trimmed,
        unmeasured: Boolean(shot.voiceAssetId) && voiceSec === null,
        maxVisualSec: await maxVisualSec(
          deps,
          shot.assetId ? assets.get(shot.assetId) : undefined,
          trimmed,
        ),
        canDonate: !NEVER_DONATE.has(shot.visualTreatment),
        overlayHoldSec: overlayHoldSec(shot.overlays, shot.durationSec),
        readingWords: wordCount(card ? shot.onScreenText || shot.voiceoverText : shot.onScreenText),
      };
    }),
  );
}

/** The narration's fit once its shot was lengthened: heard whole, no trim. */
export function rebalancedFit(previous: FitDecision, moved: RebalanceLengthened): FitDecision {
  return {
    strategy: 'rebalance',
    voiceSec: previous.voiceSec,
    shotSec: moved.fromSec,
    newShotSec: moved.toSec,
    donors: moved.donors,
    budgetSec: moved.budgetSec,
    ...(previous.speedApplied && { speedApplied: true }),
  };
}

async function applyPlan(
  deps: PipelineDeps,
  shots: readonly ScriptShot[],
  assets: ReadonlyMap<string, VideoAsset>,
  plan: RebalancePlan,
): Promise<Map<string, FitDecision>> {
  const fits = new Map<string, FitDecision>();
  for (const moved of plan.lengthened) {
    const shot = shots.find((s) => s.id === moved.shotId);
    const asset = shot?.voiceAssetId ? assets.get(shot.voiceAssetId) : undefined;
    const previous = asset ? fitOf(asset.metadata) : null;
    if (asset && previous) fits.set(asset.id, rebalancedFit(previous, moved));
  }
  await deps.db.$transaction(async (tx) => {
    for (const shot of shots) {
      const toSec = plan.durations[shot.id];
      if (toSec === undefined) continue;
      await tx.videoShot.update({ where: { id: shot.id }, data: { durationSec: toSec } });
      for (const overlay of retimedOverlays(shot.overlays, shot.durationSec, toSec))
        await tx.textOverlay.update({
          where: { id: overlay.id },
          data: { endAtSec: overlay.endAtSec },
        });
    }
    for (const [assetId, fit] of fits) {
      const metadata = assets.get(assetId)?.metadata;
      const base =
        metadata && typeof metadata === 'object' && !Array.isArray(metadata)
          ? (metadata as Record<string, unknown>)
          : {};
      await tx.videoAsset.update({
        where: { id: assetId },
        data: { metadata: { ...base, fit: { ...fit } } as Prisma.InputJsonValue },
      });
    }
  });
  return fits;
}

function shortenedOf(
  script: { id: string; targetPlatform: string },
  shots: readonly ScriptShot[],
  fitOfShot: (shot: ScriptShot) => FitDecision | null,
): NarrationShortened[] {
  return shots.flatMap((shot, index) => {
    const fit = fitOfShot(shot);
    if (fit?.strategy !== 'trim') return [];
    return [
      {
        scriptId: script.id,
        platform: script.targetPlatform,
        shotId: shot.id,
        shotNumber: index + 1,
        voiceSec: typeof fit.voiceSec === 'number' ? fit.voiceSec : null,
        keptSec: fit.trimSec ?? shot.durationSec,
        boundary: fit.sentenceBoundary ? 'sentence' : fit.wordBoundary ? 'word' : 'none',
        droppedWords: fit.droppedWords ?? 0,
      },
    ];
  });
}

/**
 * Rebalance every script of the run before it is composed. Returns how many shots were lengthened
 * and the narration that is still shortened.
 */
export async function rebalanceNarration(
  deps: PipelineDeps,
  input: { projectId: string; organisationId: string; runId: string },
): Promise<{ lengthened: number; shortened: NarrationShortened[] }> {
  const project = await deps.db.videoProject.findFirst({
    where: { id: input.projectId, organisationId: input.organisationId },
    select: {
      sourceType: true,
      metadata: true,
      scripts: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          targetPlatform: true,
          targetDurationSec: true,
          shots: {
            orderBy: { sortOrder: 'asc' },
            select: {
              id: true,
              sortOrder: true,
              durationSec: true,
              visualTreatment: true,
              assetId: true,
              voiceAssetId: true,
              onScreenText: true,
              voiceoverText: true,
              overlays: { select: { id: true, startAtSec: true, endAtSec: true } },
            },
          },
        },
      },
    },
  });
  const none = { lengthened: 0, shortened: [] };
  if (!project || project.sourceType === 'SLIDESHOW' || currentRunId(project) !== input.runId)
    return none;
  const assetIds = project.scripts.flatMap((s) =>
    s.shots.flatMap((shot) => [shot.assetId, shot.voiceAssetId]),
  );
  const assets = new Map(
    (
      await deps.db.videoAsset.findMany({
        where: {
          id: { in: assetIds.filter((id): id is string => Boolean(id)) },
          organisationId: input.organisationId,
        },
      })
    ).map((a) => [a.id, a]),
  );

  let lengthened = 0;
  const shortened: NarrationShortened[] = [];
  for (const script of project.scripts) {
    const shots: ScriptShot[] = script.shots;
    const plan = rebalanceShots(await rebalanceInput(deps, shots, assets), {
      budgetSec: scriptGrowBudgetSec(
        script.targetDurationSec,
        shots.reduce((sum, s) => sum + s.durationSec, 0),
      ),
    });
    const fits = plan.lengthened.length
      ? await applyPlan(deps, shots, assets, plan)
      : new Map<string, FitDecision>();
    lengthened += plan.lengthened.length;
    if (plan.lengthened.length)
      deps.logger.info(
        { projectId: input.projectId, scriptId: script.id, lengthened: plan.lengthened },
        'narration given time from other shots instead of being trimmed',
      );
    shortened.push(
      ...shortenedOf(script, shots, (shot) => {
        if (!shot.voiceAssetId) return null;
        return (
          fits.get(shot.voiceAssetId) ?? fitOf(assets.get(shot.voiceAssetId)?.metadata ?? null)
        );
      }),
    );
  }
  if (shortened.length)
    deps.logger.warn(
      { projectId: input.projectId, shortened },
      'narration still shortened after rebalancing',
    );
  await mergeProjectMetadata(deps.db, {
    projectId: input.projectId,
    runId: input.runId,
    patch: { narrationShortened: shortened },
  });
  return { lengthened, shortened };
}
