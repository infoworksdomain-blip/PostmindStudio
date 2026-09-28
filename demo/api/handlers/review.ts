// Review-screen endpoints: one shot (with sample thumbnails), shot regenerate / text edit, render
// preview + download (recorded sample clips captioned from the script) and force-approve.
import type { Render } from '@/lib/client/types';
import { sampleVideo, sceneImage, type Aspect } from '../../media';
import { DemoHttpError, route } from '../registry';
import { DEMO_USER_ID } from '../ids';
import { startShotRun } from './pipeline-sim';
import { swapShotAsset } from './p13-a1-create-review';
import { findRender, findShot, touch, type ProjectRec } from './projects-store';

const SHOT_EDITABLE = new Set(['READY_FOR_REVIEW', 'QUALITY_FAILED', 'FAILED', 'REJECTED']);
const ASPECTS = new Set<string>(['9:16', '16:9', '1:1', '4:5']);
const THUMB: Record<string, [number, number]> = {
  '9:16': [270, 480],
  '16:9': [480, 270],
  '1:1': [360, 360],
  '4:5': [320, 400],
};

route('GET', '/shots/:id', ({ params }) => {
  const { script, shot } = findShot(params.id ?? '');
  const [w, h] = THUMB[script.targetAspectRatio] ?? [270, 480];
  const { kind, assets, ...row } = shot;
  return {
    shot: {
      ...row,
      assets: assets.map((a) => ({
        ...a,
        publicUrl: a.kind === 'AUDIO_VOICE' ? null : (a.publicUrl ?? sceneImage(kind, w, h)),
        thumbnailUrl: a.kind === 'AUDIO_VOICE' ? null : sceneImage(kind, w, h),
      })),
    },
  };
});

function assertEditable(p: ProjectRec): void {
  if (!SHOT_EDITABLE.has(p.state))
    throw new DemoHttpError(
      409,
      'conflict',
      `Shots can be regenerated once the project has finished (project is ${p.state})`,
    );
}

const text = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === 'string' ? v.trim() || null : undefined;

route('PATCH', '/shots/:id', ({ params, body }) => {
  // 13.2: { assetId | imageLibraryId } swaps the shot's visual (p13-a1-create-review.ts).
  const swap = (body ?? {}) as Record<string, unknown>;
  if ('assetId' in swap || 'imageLibraryId' in swap) return swapShotAsset(params.id ?? '', swap);
  const { project, script, shot } = findShot(params.id ?? '');
  assertEditable(project);
  const b = (body ?? {}) as Record<string, unknown>;
  const voiceover = text(b.voiceoverText);
  const onScreen = text(b.onScreenText);
  if (voiceover === undefined && onScreen === undefined)
    throw new DemoHttpError(400, 'validation_error', 'Nothing to update');
  const voiceRegenerated = voiceover !== undefined && voiceover !== shot.voiceoverText;
  if (voiceover !== undefined) shot.voiceoverText = voiceover;
  if (onScreen !== undefined) shot.onScreenText = onScreen;
  script.fullText = script.shots
    .map((s) => s.voiceoverText)
    .filter(Boolean)
    .join('\n\n');
  startShotRun(project, script, shot.id);
  return {
    status: 202,
    body: { shotId: shot.id, runId: String(project.metadata?.runId ?? ''), voiceRegenerated },
  };
});

route('POST', '/shots/:id/regenerate', ({ params, body }) => {
  const { project, script, shot } = findShot(params.id ?? '');
  assertEditable(project);
  const prompt = text((body as Record<string, unknown> | undefined)?.prompt);
  if (prompt) shot.sceneDescription = prompt;
  startShotRun(project, script, shot.id);
  return { status: 202, body: { shotId: shot.id, runId: String(project.metadata?.runId ?? '') } };
});

// ------------------------------------------------------------------ renders

async function clipFor(project: ProjectRec, render: Render): Promise<string> {
  const script = project.scripts.find((s) => s.id === render.scriptId);
  const caption =
    script?.shots.find((s) => s.onScreenText)?.onScreenText ??
    project.brief?.hook ??
    project.name ??
    '';
  const aspect: Aspect = ASPECTS.has(render.aspectRatio) ? (render.aspectRatio as Aspect) : '9:16';
  const url = await sampleVideo({ scene: project.scene, aspect, seconds: 4, caption });
  if (!url)
    throw new DemoHttpError(
      503,
      'preview_unavailable',
      'This browser can’t record the sample clip.',
    );
  return url;
}

route('GET', '/renders/:id', ({ params }) => ({ render: findRender(params.id ?? '').render }));

route('GET', '/renders/:id/preview', async ({ params }) => {
  const { project, render } = findRender(params.id ?? '');
  return { url: await clipFor(project, render), expiresInSec: 900 };
});

route('GET', '/renders/:id/download', async ({ params }) => {
  const { project, render } = findRender(params.id ?? '');
  return { url: await clipFor(project, render), expiresInSec: 300 };
});

route('POST', '/renders/:id/force-approve', ({ params, body }) => {
  const { project, render } = findRender(params.id ?? '');
  const note = text((body as Record<string, unknown> | undefined)?.note);
  if (!note) throw new DemoHttpError(400, 'validation_error', 'note is required');
  if (render.qualityCheckState !== 'FAILED')
    throw new DemoHttpError(
      409,
      'conflict',
      `Render quality state is ${render.qualityCheckState}; only FAILED renders can be force-approved`,
    );
  render.qualityCheckState = 'FORCE_APPROVED';
  render.qualityIssues = [
    ...(render.qualityIssues ?? []),
    {
      code: 'force_approved',
      status: 'passed',
      severity: 'info',
      detail: `by ${DEMO_USER_ID}: ${note}`,
    },
  ];
  const allClear = project.renders.every(
    (r) => r.qualityCheckState === 'PASSED' || r.qualityCheckState === 'FORCE_APPROVED',
  );
  const ready = allClear && project.state === 'QUALITY_FAILED';
  if (ready) touch(project, { state: 'READY_FOR_REVIEW', errorReason: null });
  return { renderId: render.id, projectReadyForReview: ready };
});
