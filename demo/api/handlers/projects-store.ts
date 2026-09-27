// In-memory store behind the demo's project endpoints: projects with their brief, scripts (full
// shots), renders and approvals. Publications live in the shared publications-store (agent
// "manage"); the detail view joins them in. Builders turn projects-content.ts into rows.
import type { Project, QualityIssue, Render, Shot, TargetFormat } from '@/lib/client/types';
import type { SceneKind } from '../../media';
import { DemoHttpError } from '../registry';
import { DEMO_BUSINESS_ID, DEMO_ORG_ID } from '../ids';
import type { BriefContent, ProjectContent, ShotContent } from './projects-content';

export interface AssetRec {
  id: string;
  kind: 'VIDEO_CLIP' | 'IMAGE' | 'AUDIO_VOICE';
  mimeType: string;
  durationSec: number | null;
  source: string;
  /** Sample thumbnail (sceneImage) — drawn lazily when the shot is fetched. */
  publicUrl: string | null;
}

export interface ShotRec extends Shot {
  kind: SceneKind;
  assets: AssetRec[];
}

export interface ScriptRec {
  id: string;
  projectId: string;
  targetPlatform: string;
  targetAspectRatio: string;
  targetDurationSec: number;
  fullText: string;
  scriptModel: string;
  shots: ShotRec[];
}

export interface ApprovalRec {
  id: string;
  state: string;
  note: string | null;
  createdAt: string;
  resolvedByUserId: string | null;
}

export interface ProjectRec extends Project {
  brief: BriefContent | null;
  scripts: ScriptRec[];
  renders: Render[];
  approvals: ApprovalRec[];
  /** Demo-only: the illustration family for this project's media. */
  scene: SceneKind;
  templateId: string | null;
}

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const NOW = Date.now();
export const ago = (ms: number) => new Date(NOW - ms).toISOString();
export const nowIso = () => new Date().toISOString();

let counter = 0;
export const newId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${(counter++).toString(36)}`;

const projects = new Map<string, ProjectRec>();

export function putProject(p: ProjectRec): ProjectRec {
  projects.set(p.id, p);
  return p;
}

export function allProjects(): ProjectRec[] {
  return [...projects.values()].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
}

export function getProject(id: string): ProjectRec {
  const p = projects.get(id);
  if (!p) throw new DemoHttpError(404, 'not_found', 'Project not found');
  return p;
}

/** Name lookup for other demo areas (publications, analytics, notifications). */
export function demoProjectName(id: string): string | null {
  return projects.get(id)?.name ?? null;
}

export function touch(p: ProjectRec, patch: Partial<ProjectRec> = {}): ProjectRec {
  Object.assign(p, patch, { updatedAt: nowIso() });
  return p;
}

export function setMeta(p: ProjectRec, patch: Record<string, unknown>): void {
  p.metadata = { ...(p.metadata ?? {}), ...patch };
}

/** The public Project row (list + mutation responses) without demo-only fields. */
export function toProject(p: ProjectRec): Project & { templateId: string | null } {
  const {
    brief: _brief,
    scripts: _scripts,
    renders: _renders,
    approvals: _approvals,
    scene: _scene,
    ...row
  } = p;
  return { ...row, targetFormats: row.targetFormats.map((f) => ({ ...f })) };
}

export function findShot(shotId: string): {
  project: ProjectRec;
  script: ScriptRec;
  shot: ShotRec;
} {
  for (const project of projects.values())
    for (const script of project.scripts) {
      const shot = script.shots.find((s) => s.id === shotId);
      if (shot) return { project, script, shot };
    }
  throw new DemoHttpError(404, 'not_found', 'Shot not found');
}

export function findRender(renderId: string): { project: ProjectRec; render: Render } {
  for (const project of projects.values()) {
    const render = project.renders.find((r) => r.id === renderId);
    if (render) return { project, render };
  }
  throw new DemoHttpError(404, 'not_found', 'Render not found');
}

// ------------------------------------------------------------------ builders

const RESOLUTION: Record<string, string> = {
  '9:16': '1080x1920',
  '16:9': '1920x1080',
  '1:1': '1080x1080',
  '4:5': '1080x1350',
};
const SHORT: Record<string, string> = {
  tiktok: 'tt',
  youtube_short: 'yts',
  instagram_reel: 'ig',
  youtube: 'yt',
  linkedin_video: 'li',
  x: 'x',
  facebook: 'fb',
};

export const fmt = (
  platform: string,
  aspectRatio: TargetFormat['aspectRatio'],
  duration: number,
): TargetFormat => ({ platform, aspectRatio, duration });

function shotRec(
  scriptId: string,
  id: string,
  index: number,
  c: ShotContent,
  state: string,
): ShotRec {
  const ready = state === 'READY';
  return {
    id,
    scriptId,
    sortOrder: index,
    durationSec: c.durationSec,
    visualTreatment: c.treatment,
    state,
    errorReason: null,
    sceneDescription: c.scene,
    cameraDirection: c.camera,
    voiceoverText: c.voiceover,
    onScreenText: c.onScreen,
    transitionOut: c.transitionOut ?? (index === 0 ? 'cut' : 'fade'),
    assetId: ready ? `${id}-clip` : null,
    voiceAssetId: ready && c.voiceover ? `${id}-voice` : null,
    kind: c.kind,
    assets: ready ? shotAssets(id, c) : [],
  };
}

export function shotAssets(
  shotId: string,
  c: Pick<ShotContent, 'treatment' | 'durationSec' | 'voiceover'>,
): AssetRec[] {
  const still = c.treatment === 'IMAGE_STILL' || c.treatment === 'TEXT_CARD';
  const assets: AssetRec[] = [
    {
      id: `${shotId}-clip`,
      kind: still ? 'IMAGE' : 'VIDEO_CLIP',
      mimeType: still ? 'image/png' : 'video/mp4',
      durationSec: still ? null : c.durationSec,
      source:
        c.treatment === 'AI_AVATAR'
          ? 'heygen:avatar-v3'
          : still
            ? 'studio:compose'
            : 'runway:gen-4-turbo',
      publicUrl: null,
    },
  ];
  if (c.voiceover)
    assets.push({
      id: `${shotId}-voice`,
      kind: 'AUDIO_VOICE',
      mimeType: 'audio/mpeg',
      durationSec: Math.max(1, c.durationSec - 0.4),
      source: 'elevenlabs:multilingual-v2',
      publicUrl: null,
    });
  return assets;
}

/** One script per target format, all sharing the project's shot list. */
export function buildScripts(
  projectId: string,
  formats: TargetFormat[],
  content: ProjectContent,
  shotState = 'READY',
): ScriptRec[] {
  const run = Date.now().toString(36).slice(-4);
  return formats.map((f) => {
    const scriptId = `scr-${projectId.replace(/^prj-/, '')}-${SHORT[f.platform] ?? f.platform}-${run}`;
    const shots = content.shots.map((c, i) =>
      shotRec(scriptId, `${scriptId}-s${i + 1}`, i, c, shotState),
    );
    return {
      id: scriptId,
      projectId,
      targetPlatform: f.platform,
      targetAspectRatio: f.aspectRatio,
      targetDurationSec: content.shots.reduce((s, c) => s + c.durationSec, 0) || f.duration,
      fullText: content.shots
        .map((c) => c.voiceover)
        .filter(Boolean)
        .join('\n\n'),
      scriptModel: 'anthropic:claude-sonnet-4-5',
      shots,
    };
  });
}

const PASSED: Array<[string, string]> = [
  ['duration.within_limits', 'Duration fits the platform limit.'],
  ['resolution.matches_format', 'Resolution and aspect ratio match the target format.'],
  ['audio.loudness', 'Integrated loudness −14.2 LUFS (target −14 ±1).'],
  ['captions.safe_zone', 'On-screen text stays inside the platform safe zone.'],
  ['video.black_frames', 'No black or frozen frames detected.'],
  ['content_safety', 'No content-safety concerns found.'],
  ['brand.colours', 'Brand colours and logo placement follow the brand kit.'],
];

export function qualityIssues(failLoudness = false): QualityIssue[] {
  return PASSED.map(([code, detail]): QualityIssue =>
    failLoudness && code === 'audio.loudness'
      ? {
          code,
          status: 'failed' as const,
          severity: 'error',
          detail:
            'Integrated loudness −8.9 LUFS, true peak +0.4 dBTP: too loud for TikTok (target −14 LUFS ±1, peak ≤ −1 dBTP). Regenerate or force-approve.',
        }
      : { code, status: 'passed' as const, severity: 'info', detail },
  ).concat(
    failLoudness
      ? [
          {
            code: 'captions.readability',
            status: 'warning',
            severity: 'warning',
            detail:
              'Shot 2 caption is on screen for 1.1 s — shorter than the 1.5 s reading minimum.',
          },
        ]
      : [],
  );
}

export function buildRender(
  project: ProjectRec,
  script: ScriptRec,
  opts: {
    id?: string;
    state?: Render['qualityCheckState'];
    failLoudness?: boolean;
    createdAt?: string;
  } = {},
): Render {
  const state = opts.state ?? 'PASSED';
  return {
    id: opts.id ?? newId('rnd'),
    projectId: project.id,
    scriptId: script.id,
    targetPlatform: script.targetPlatform,
    aspectRatio: script.targetAspectRatio,
    resolution: RESOLUTION[script.targetAspectRatio] ?? '1080x1920',
    durationSec: script.targetDurationSec,
    qualityCheckState: state,
    qualityIssues: state === 'PENDING' ? null : qualityIssues(opts.failLoudness),
    costPence: 18 + script.shots.length * 3,
    createdAt: opts.createdAt ?? nowIso(),
  };
}

export function baseProject(
  id: string,
  name: string,
  over: Partial<ProjectRec> & Pick<ProjectRec, 'state' | 'targetFormats' | 'scene'>,
): ProjectRec {
  return {
    id,
    organisationId: DEMO_ORG_ID,
    businessId: DEMO_BUSINESS_ID,
    name,
    description: null,
    sourceType: 'BRIEF',
    referenceVideoId: null,
    referenceMode: null,
    brandKitId: 'bk-main',
    costBudgetPence: 500,
    costActualPence: 0,
    reviewPolicy: 'REQUIRE_APPROVAL',
    publishPolicy: 'MANUAL',
    errorReason: null,
    metadata: {},
    createdAt: ago(DAY),
    updatedAt: ago(HOUR),
    completedAt: null,
    brief: null,
    scripts: [],
    renders: [],
    approvals: [],
    templateId: null,
    ...over,
  };
}
