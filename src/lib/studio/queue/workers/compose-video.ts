import type { Prisma } from '@prisma/client';
import { NotFoundError } from '../../../errors';
import type { CompositionSummary } from '../../pipeline/composition-summary';
import type { RenderPreset } from '../../pipeline/render-presets';
import type { AspectRatio } from '../../providers/interface';
import type { PipelineDeps } from '../../pipeline/deps';
import {
  buildShotstackComposition,
  editDuration,
  outputDimensions,
  type EdlShot,
} from '../../pipeline/edl';
import { cardSec } from '../../pipeline/edl-brand';
import {
  platformCardFromEnv,
  resolveBrand,
  resolveProjectBrandKit,
  resolveWhiteLabel,
  type ResolvedBrand,
} from '../../pipeline/brand-resolve';
import { parseRenderOptions, resolvePreset, withPreset } from '../../pipeline/render-presets';
import { findCachedRender, withEdlHash } from '../../pipeline/compose-cache';
import { edlHash } from '../../pipeline/edl-hash';
import { shotFallbacks, type FallbackNotice } from '../../pipeline/fallback-notice';
import { degradedShotsOf } from '../../pipeline/avatar-fallback';
import { voiceTrimSecOf } from '../../pipeline/voice-fit';
import { rebalanceNarration } from '../../pipeline/narration-rebalance';
import {
  currentRunId,
  failProject,
  mergeProjectMetadata,
  recordRunRender,
  projectMetadata,
  transitionProject,
} from '../../pipeline/project-state';
import { produceMusic } from '../../pipeline/music';
import { produceSfx, type SfxClip } from '../../pipeline/sfx';
import { spokenWordsOf } from '../../pipeline/word-timing';
import { slideOverlayPlacements } from '../../slideshow/slide-overlays';
import {
  cancelPendingRenders,
  completeComposition,
  nextPollDelayMs,
  schedulePoll,
  StaleRunError,
  submitRender,
} from '../../pipeline/render-async';
import { MASTERING_KEY, pendingRendersOf, setRunEntry } from '../../pipeline/render-state';
import type { MasteringReport } from '../../pipeline/mastering';
import { buildOverlayTrack, mergeOverlayTrack, type PlacedOverlay } from '../../overlays/compose';
import { buildSlideshowEdit, slideshowDuration } from '../../slideshow/edl';
import { ensureVoiceCaptions } from '../../overlays/voice-captions';
import { resolveSlides } from '../../slideshow/resolve';
import { clipSpeaks, speechAssetIdOf } from '../../ugc/clip-speech';
import { ugcStyleOf } from '../../ugc/style';
import type { ProjectJobData } from '../queues';
import { readHookDemo } from '../../formats/hook-demo';
import { hookDemoEdl } from '../../formats/hook-demo-edl';
import { clipLetterboxes } from '../../pipeline/letterbox-assets';
import { renderLocalVariants } from '../../render/local/compose-local';

/** width ÷ height of a stored asset, when it was probed (uploads; library clips are not). */
function aspectOf(asset: { widthPx: number | null; heightPx: number | null } | undefined) {
  return asset?.widthPx && asset.heightPx ? asset.widthPx / asset.heightPx : null;
}

// BACKLOG 3.6 — Layers 5–7 (spec 4.5 step 6): music (ElevenLabs Music, pipeline/music.ts), Shotstack edit list per script,
// render, copy the MP4 into the renders bucket, probe it, record video_renders, then hand off to
// the quality gate. Renders completed by an earlier attempt are reused (metadata.renders).
// Phase 15: brand-kit media + fonts per language (15.B1, P2 white-label, P6 AI label), render
// presets (15.B7), the composition cache (15.B6: an identical edit re-points to the existing
// render), the timeline summary for the quality gate (15.B2) and fallback notices (15.B9).

export async function composeVideo(data: ProjectJobData, deps: PipelineDeps): Promise<void> {
  const log = deps.logger.child({
    projectId: data.projectId,
    organisationId: data.organisationId,
    runId: data.runId,
  });
  // 21.1: narration that overran its shot gets time from other shots' slack before anything is
  // trimmed (shot lengths change here, so captions and the edit below are built from them).
  await rebalanceNarration(deps, data);
  // 15.A4 (Track A): burned-in narration captions as editable overlays before the edit is built.
  await ensureVoiceCaptions(deps, data);
  const project = await deps.db.videoProject.findUnique({
    where: { id: data.projectId },
    include: {
      scripts: {
        include: { shots: { orderBy: { sortOrder: 'asc' }, include: { overlays: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!project || project.organisationId !== data.organisationId)
    throw new NotFoundError('Project not found');
  if (currentRunId(project) !== data.runId) return log.info('stale compose-video job ignored');

  const ugcVideo = ugcStyleOf(project.metadata) !== null;
  const hookDemo = project.sourceType === 'HOOK_DEMO' ? readHookDemo(project.metadata) : null;
  const failed = project.scripts.flatMap((s) => s.shots).filter((shot) => shot.state === 'FAILED');
  if (failed.length > 0) {
    await failProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      reason: `asset_generation_failed: ${failed.map((s) => `shot ${s.sortOrder + 1}: ${s.errorReason ?? 'unknown'}`).join('; ')}`,
    });
    return log.warn({ failedShots: failed.length }, 'shots failed; project failed');
  }

  if (project.state !== 'RENDERING') {
    const moved = await transitionProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      from: ['ASSETS_QUEUED', 'ASSETS_GENERATING'],
      to: 'RENDERING',
    });
    if (!moved) return log.info({ state: project.state }, 'project not ready to render; skipped');
  }

  const assetIds = project.scripts
    .flatMap((s) => s.shots.flatMap((shot) => [shot.assetId, shot.voiceAssetId]))
    .filter((id): id is string => Boolean(id));
  const assets = new Map(
    (
      await deps.db.videoAsset.findMany({
        where: { id: { in: assetIds }, organisationId: project.organisationId },
      })
    ).map((a) => [a.id, a]),
  );
  // 22.6: black bars baked into a clip are cropped off (measured once per asset, letterbox.ts).
  const clipBars = await clipLetterboxes(deps, assets.values());
  const signed = async (id: string | null) => {
    const asset = id ? assets.get(id) : undefined;
    return asset
      ? { url: await deps.storage.signedUrl(asset.s3Bucket, asset.s3Key), kind: asset.kind }
      : undefined;
  };

  const renders: Record<string, string> = {
    ...((projectMetadata(project.metadata).renders as Record<string, string>) ?? {}),
  };
  // Same resolution as ideation/overlays/voice: the project's kit, else the business default.
  const kit = await resolveProjectBrandKit(deps.db, project);
  // 15.B1: brand media and fonts, resolved once per script language (fonts follow the script).
  const brandByLanguage = new Map<string, ResolvedBrand>();
  const brandFor = async (language: string): Promise<ResolvedBrand> => {
    const cached = brandByLanguage.get(language);
    if (cached) return cached;
    const resolved = await resolveBrand(
      { db: deps.db, storage: deps.storage, fontsBaseUrl: deps.config.fontsBaseUrl },
      kit,
      language,
    );
    brandByLanguage.set(language, resolved);
    return resolved;
  };
  // P2: white-label outputs never carry a Studio mark; others get the optional platform card.
  const whiteLabel = await resolveWhiteLabel(deps.db, project.organisationId, data.planTier);
  const platformCard = whiteLabel ? undefined : platformCardFromEnv();
  const renderOptions = parseRenderOptions(project.renderOptions);
  const palette = Array.isArray(kit?.colourPalette)
    ? (kit.colourPalette as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];

  // Slideshows (A5) compose from their slides; scripted videos from their shots.
  const slideOverlays =
    project.sourceType === 'SLIDESHOW' ? await slideOverlayPlacements(deps.db, project.id) : [];
  const slides =
    project.sourceType === 'SLIDESHOW'
      ? (await resolveSlides(deps, project)).map((slide, i) => ({
          ...slide,
          // 13.4: a slide's styled overlays replace its plain caption band.
          hasOverlays: (slideOverlays[i]?.length ?? 0) > 0,
        }))
      : undefined;
  const brand = {
    backgroundColour: palette[0],
    textColour: palette[1],
    palette,
  };
  const primaryBrand = await brandFor(project.scripts[0]?.language ?? 'en-GB');
  const cardsSec =
    cardSec(primaryBrand.media.intro) + cardSec(primaryBrand.media.outro) + cardSec(platformCard);

  // Layer 5 — one music track for the run, sized to the longest variant (pipeline/music.ts).
  // Non-fatal: without a track the video renders with narration only.
  const longestSec = slides
    ? slideshowDuration(slides)
    : cardsSec +
      Math.max(0, ...project.scripts.map((s) => s.shots.reduce((t, x) => t + x.durationSec, 0)));
  // 13.5: an uploaded video keeps its own soundtrack, so no music bed is generated for it.
  const track =
    project.sourceType === 'UPLOAD'
      ? null
      : await produceMusic(deps, {
          project,
          runId: data.runId,
          planTier: data.planTier,
          videoSec: longestSec,
          kit,
        });
  const music = track
    ? {
        musicSrc: await deps.storage.signedUrl(track.bucket, track.key),
        musicDurationSec: track.durationSec,
      }
    : {};
  // 13.27 — Layer 5 sound effects from the Layer 2 cues (pipeline/sfx.ts). Non-fatal.
  const sfxClips = slides
    ? new Map<string, SfxClip>()
    : await produceSfx(deps, {
        project,
        runId: data.runId,
        planTier: data.planTier,
        shots: project.scripts.flatMap((s) => s.shots),
      });
  const sfxUrls = new Map<string, string>();
  for (const clip of new Set(sfxClips.values())) {
    sfxUrls.set(`${clip.bucket}/${clip.key}`, await deps.storage.signedUrl(clip.bucket, clip.key));
  }

  const sfxFor = (shotId: string) => {
    const clip = sfxClips.get(shotId);
    const url = clip && sfxUrls.get(`${clip.bucket}/${clip.key}`);
    return url ? { sfxSrc: url, sfxDurationSec: clip.durationSec } : {};
  };

  const cacheHits: Array<{ scriptId: string; renderId: string }> = [];
  // 15.B9: generations that used a fallback provider (shown on the review screen).
  const fallbacks: FallbackNotice[] = project.scripts.flatMap((s) =>
    s.shots.flatMap((shot) => shotFallbacks(shot.id, shot.providerRouting)),
  );
  const shotEdit = async (script: (typeof project.scripts)[number], preset: RenderPreset) => {
    const scriptShots = script.shots;
    const aspectRatio = script.targetAspectRatio as AspectRatio;
    const brandKit = await brandFor(script.language);
    const shots: EdlShot[] = await Promise.all(
      scriptShots.map(async (shot) => {
        const visual = await signed(shot.assetId);
        const voice = await signed(shot.voiceAssetId);
        const voiceAsset = shot.voiceAssetId ? assets.get(shot.voiceAssetId) : undefined;
        return {
          id: shot.id,
          durationSec: shot.durationSec,
          // 15.B3: narration that could not be fitted stops at a word boundary.
          voiceTrimSec: voiceAsset ? voiceTrimSecOf(voiceAsset.metadata) : null,
          visualTreatment: shot.visualTreatment,
          visualSrc: visual?.url,
          visualKind: visual?.kind === 'IMAGE' ? ('image' as const) : ('video' as const),
          ...(shot.assetId &&
            clipBars.has(shot.assetId) && {
              sourceCrop: clipBars.get(shot.assetId),
            }),
          voiceSrc: voice?.url,
          // 13.5: an uploaded clip carries its own audio (no narration is generated for it).
          keepSourceAudio: shot.visualTreatment === 'USER_UPLOAD' && !shot.voiceAssetId,
          // 21.4: a UGC actor clip's own audio is the narration.
          clipSpeech: clipSpeaks(shot),
          // Styled overlays (Feature B) replace the plain caption when the shot has any.
          onScreenText: shot.overlays.length ? null : shot.onScreenText,
          transitionOut: shot.transitionOut,
          cardText: shot.onScreenText ?? shot.voiceoverText,
          ...sfxFor(shot.id),
        };
      }),
    );
    // 22.1: a hook + demo script: silent hook, the demo's audio at the mix, the stacked layout.
    const hookLayout = hookDemo
      ? hookDemoEdl(shots, {
          doc: hookDemo,
          aspectRatio,
          frame: outputDimensions(aspectRatio, preset.resolution),
          demoAspect: aspectOf(assets.get(scriptShots[1]?.assetId ?? '')),
          hookAspect: aspectOf(assets.get(scriptShots[0]?.assetId ?? '')),
          hookFromLibrary:
            assets.get(scriptShots[0]?.assetId ?? '')?.source.startsWith('library:') ?? false,
        })
      : null;
    const composition = buildShotstackComposition({
      aspectRatio,
      shots: hookLayout?.shots ?? shots,
      ...(hookLayout && { musicUnderSpeechVolume: hookLayout.musicUnderSpeechVolume }),
      brand: {
        ...brand,
        fontFamily: brandKit.fonts.fontFamily ?? undefined,
        fontSources: brandKit.fonts.fontSources,
      },
      brandMedia: brandKit.media,
      // 21.4: a video with a generated actor always carries the AI-generated label (22.1: so
      // does a hook + demo video whose hook is a generated person).
      aiLabel: brandKit.aiLabel || ugcVideo || Boolean(hookLayout?.aiHook),
      // 21.4b: no boxed headlines in a UGC video (its labels are native-look overlays).
      ugc: ugcVideo,
      platformCard,
      language: script.language,
      preset,
      ...music,
    });
    // Shot overlays sit after the intro card (15.B1).
    let offset = composition.summary.introSec;
    const placed: PlacedOverlay[] = scriptShots.flatMap((shot) => {
      const at = offset;
      offset += shot.durationSec;
      // 13.6: karaoke follows the narration's spoken words (or an uploaded clip's own speech).
      const speechId = speechAssetIdOf(shot);
      const spokenFrom = speechId
        ? assets.get(speechId)
        : shot.visualTreatment === 'USER_UPLOAD' && shot.assetId
          ? assets.get(shot.assetId)
          : undefined;
      const words = spokenFrom ? spokenWordsOf(spokenFrom.metadata) : [];
      return shot.overlays.map((row) => ({ row, offsetSec: at, words }));
    });
    return {
      edit: composition.edit,
      summary: composition.summary as CompositionSummary | null,
      outputDurationSec: editDuration(shots, brandKit.media) + cardSec(platformCard),
      placed,
    };
  };

  // Whole-video overlays (e.g. a watermark) attached to an earlier render of the same platform.
  const earlierRenders = await deps.db.videoRender.findMany({
    where: { projectId: project.id },
    select: { id: true, targetPlatform: true },
  });
  const renderOverlays = await deps.db.textOverlay.findMany({
    where: { renderId: { in: earlierRenders.map((r) => r.id) } },
  });
  const platformOf = new Map(earlierRenders.map((r) => [r.id, r.targetPlatform]));

  /** Put the overlay tracks on top of the edit (tracks[0] is the top layer). */
  const withOverlays = async (
    edit: Record<string, unknown>,
    placed: PlacedOverlay[],
    aspectRatio: AspectRatio,
    preset: RenderPreset,
    language?: string,
  ) => {
    if (placed.length === 0) return edit;
    const track = await buildOverlayTrack(placed, {
      frame: outputDimensions(aspectRatio, preset.resolution),
      organisationId: project.organisationId,
      language, // 15.C5: overlay fonts + RTL per script language (overlays/script-fonts.ts)
      preRender: {
        storage: deps.storage,
        bucket: deps.config.rendersBucket,
        fetchImpl: deps.fetch,
        fontsBaseUrl: deps.config.fontsBaseUrl,
      },
    });
    if (track.skipped.length)
      log.warn({ overlayIds: track.skipped }, 'overlays with an invalid style were skipped');
    return mergeOverlayTrack(edit, track);
  };

  // 23.1 / 23.6: two phases. (1) Every variant's edit is built (and composition-cache hits
  // recorded); (2) every remaining render is submitted to the composer at once. Variants already
  // rendered (metadata.renders) or still rendering (metadata.pendingRenders, an earlier attempt)
  // are skipped, so a retry re-submits only the failed ones. Provider concurrency caps
  // (STUDIO_PROVIDER_CONCURRENCY_SHOTSTACK, 20.29) apply per render at submit.
  const pending = pendingRendersOf(project.metadata);
  const submitted = new Set<string>();
  const prepared = await Promise.all(
    project.scripts
      .filter((script) => !renders[script.id] && !pending[script.id])
      .map(async (script) => {
        const aspectRatio = script.targetAspectRatio as AspectRatio;
        const chosen = resolvePreset({
          platform: script.targetPlatform,
          planTier: data.planTier,
          options: renderOptions,
        });
        // Slideshow layouts are fixed at 1080p: a 4K request renders them at 1080.
        const preset: RenderPreset =
          slides && chosen.resolution === '4k' ? { ...chosen, resolution: '1080' } : chosen;
        const built = slides
          ? {
              edit: withSlideshowFonts(
                withPreset(
                  buildSlideshowEdit({
                    aspectRatio,
                    slides,
                    brand: { ...brand, fontFamily: primaryBrand.fonts.fontFamily ?? undefined },
                    ...music,
                  }),
                  aspectRatio,
                  preset,
                ),
                primaryBrand.fonts.fontSources,
              ),
              summary: null,
              outputDurationSec: slideshowDuration(slides),
              placed: slideOverlays.flat(),
            }
          : await shotEdit(script, preset);
        const wholeVideo = renderOverlays
          .filter((row) => row.renderId && platformOf.get(row.renderId) === script.targetPlatform)
          .map((row) => ({ row, offsetSec: 0 }));
        const outputDurationSec = built.outputDurationSec;
        const edit = await withOverlays(
          built.edit,
          [...built.placed, ...wholeVideo],
          aspectRatio,
          preset,
          script.language,
        );
        // 15.B6: an identical edit for this project and platform re-points to the render it made.
        // Asset ids are part of the key: a re-voiced shot may reuse its object key (13.1).
        const hash = edlHash(edit, {
          shots: slides
            ? []
            : script.shots.map((s) => ({
                id: s.id,
                assetId: s.assetId,
                voiceAssetId: s.voiceAssetId,
              })),
        });
        const composition = withEdlHash(built.summary, hash);
        const cached = await findCachedRender(deps, {
          projectId: project.id,
          targetPlatform: script.targetPlatform,
          edlHash: hash,
        });
        if (cached) {
          const recorded = await recordRunRender(deps.db, {
            projectId: project.id,
            runId: data.runId,
            scriptId: script.id,
            renderId: cached.id,
          });
          if (!recorded) throw new StaleRunError();
          renders[script.id] = cached.id;
          cacheHits.push({ scriptId: script.id, renderId: cached.id });
          return null;
        }
        return { script, aspectRatio, edit, outputDurationSec, composition };
      }),
  ).catch((err: unknown) => {
    if (err instanceof StaleRunError) return 'stale' as const;
    throw err;
  });
  if (prepared === 'stale') return log.info('run superseded during composition; renders discarded');

  // 15.B6 cache hits and 15.B9 fallback notices are recorded per run (the composer's own fallback
  // is appended when its render is recorded); 20.19: shots whose avatar presenter was unavailable
  // and became a generated clip.
  await mergeProjectMetadata(deps.db, {
    projectId: project.id,
    runId: data.runId,
    patch: {
      compositionCache: cacheHits,
      fallbacks,
      degradedShots: degradedShotsOf(project.scripts.flatMap((s) => s.shots)),
    },
  });

  // 23.6: every remaining render is SUBMITTED and this job ends; poll-render (render-async.ts)
  // stores, masters and records each one when it is done, then hands the run to the quality gate.
  // A renderer that returns the file at once (a local renderer) calls finishRender here instead.
  // 23.5 renderer seam: slideshows and walls of text are rendered locally with ffmpeg
  // (render/local/compose-local.ts), recorded at once; a variant it does not make is submitted below.
  const masteringReports: Record<string, MasteringReport> = {};
  const local = await renderLocalVariants(deps, {
    project,
    runId: data.runId,
    variants: prepared.filter((p): p is NonNullable<typeof p> => p !== null),
    log,
    renders,
    masteringReports,
  });
  if (local.stale) return log.info('run superseded during composition; renders discarded');
  for (const [scriptId, report] of Object.entries(masteringReports)) {
    const run = { projectId: project.id, runId: data.runId };
    if (
      !(await setRunEntry(deps.db, {
        ...run,
        key: MASTERING_KEY,
        entryKey: scriptId,
        value: report,
      }))
    )
      return log.info('run superseded during composition; renders discarded');
  }

  const settled = await Promise.allSettled(
    prepared
      .filter((p): p is NonNullable<typeof p> => p !== null && local.remaining.includes(p))
      .map(async ({ script, aspectRatio, edit, outputDurationSec, composition }) => {
        const recorded = await submitRender(deps, data, {
          scriptId: script.id,
          targetPlatform: script.targetPlatform,
          aspectRatio,
          edit,
          outputDurationSec,
          composition: composition as Prisma.JsonValue,
        });
        if (!recorded) throw new StaleRunError();
        submitted.add(script.id);
      }),
  );
  const failures = settled
    .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
    .map((s): unknown => s.reason);
  if (failures.some((err) => err instanceof StaleRunError)) {
    return log.info('run superseded during composition; renders discarded');
  }
  const waiting = Object.values(
    pendingRendersOf(
      (
        await deps.db.videoProject.findUnique({
          where: { id: project.id },
          select: { metadata: true },
        })
      )?.metadata ?? null,
    ),
  );
  if (waiting.length > 0) {
    // A new chain per compose run: its polls cover every pending render of the run.
    const delay = await nextPollDelayMs(deps, data, waiting);
    await schedulePoll(deps, data, `c${deps.now()}`, 1, delay);
  }
  if (failures.length > 0) {
    log.warn(
      { failed: failures.length, submitted: submitted.size },
      'some renders could not be submitted; submitted ones continue, the rest are retried',
    );
    throw failures[0];
  }
  if (waiting.length > 0) {
    return log.info({ submitted: submitted.size, pending: waiting.length }, 'renders submitted');
  }
  // Every variant came from the composition cache (or a renderer that returned at once).
  if (await completeComposition(deps, data))
    log.info({ renders: Object.keys(renders).length }, 'renders complete; quality gate enqueued');
}

/** Slideshow edits get the brand font sources too (timeline.fonts). */
function withSlideshowFonts(
  edit: Record<string, unknown>,
  sources: string[],
): Record<string, unknown> {
  if (sources.length === 0) return edit;
  const timeline = edit.timeline as Record<string, unknown>;
  const existing = Array.isArray(timeline.fonts) ? (timeline.fonts as Array<{ src: string }>) : [];
  const added = sources
    .filter((src) => !existing.some((f) => f.src === src))
    .map((src) => ({ src }));
  return { ...edit, timeline: { ...timeline, fonts: [...existing, ...added] } };
}

export async function onComposeVideoFailed(
  data: ProjectJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // 23.6: renders this run already submitted are stopped (their reservations released).
  await cancelPendingRenders(deps, data);
  await failProject(deps.db, {
    projectId: data.projectId,
    runId: data.runId,
    reason: `composition_failed: ${reason}`,
  });
}
