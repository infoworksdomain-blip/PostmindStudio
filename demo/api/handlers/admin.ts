// /admin/kill-switch and /admin/redrive (agent "insight"). The demo user is PostMind staff, so
// every /admin route answers (the real ones 403 anyone else).
import { DemoHttpError, route } from '../registry';
import {
  haltedWork,
  killSwitchFor,
  killSwitchState,
  markRedriven,
  markUnstuck,
  setFlag,
  stuckProjects,
  type Halted,
  type KillLevel,
} from './admin-state';
import { pendingGlobalState, requestGlobalKill } from './p15-d-admin-kill';

const LEVELS: KillLevel[] = ['global', 'workspace', 'project', 'provider', 'platform'];
const PROVIDER_IDS = [
  'anthropic',
  'openai',
  'runway',
  'veo',
  'luma',
  'kling',
  'pika',
  'fal',
  'replicate',
  'heygen',
  'synthesia',
  'd-id',
  'tavus',
  'elevenlabs',
  'azure-speech',
  'suno',
  'storyblocks',
  'pexels',
  'unsplash',
  'assemblyai',
  'shotstack',
  'creatomate',
  'hive',
  'sightengine',
];
const PLATFORMS = [
  'tiktok',
  'instagram_reel',
  'youtube_short',
  'youtube',
  'linkedin_video',
  'x',
  'facebook',
];

route('GET', '/admin/kill-switch', () => ({ ...killSwitchState(), ...pendingGlobalState() }));

interface KillBody {
  level?: KillLevel;
  target?: string;
  enabled?: boolean;
  reason?: string;
}

route('PUT', '/admin/kill-switch', ({ body }) => {
  const input = (body ?? {}) as KillBody;
  const target = input.target?.trim() || undefined;
  if (!input.level || !LEVELS.includes(input.level))
    throw new DemoHttpError(400, 'validation_error', 'level must be one of ' + LEVELS.join(', '));
  if (typeof input.enabled !== 'boolean')
    throw new DemoHttpError(400, 'validation_error', 'enabled is required');
  if (!input.reason || input.reason.trim().length < 3)
    throw new DemoHttpError(400, 'validation_error', 'reason must be at least 3 characters');
  if (input.level !== 'global' && !target)
    throw new DemoHttpError(
      400,
      'validation_error',
      'target is required for workspace, project, provider and platform levels',
    );
  if (input.level === 'provider' && !PROVIDER_IDS.includes(target ?? ''))
    throw new DemoHttpError(400, 'validation_error', 'Unknown providerId');
  if (input.level === 'platform' && !PLATFORMS.includes(target ?? ''))
    throw new DemoHttpError(400, 'validation_error', 'Unknown platform');
  // 15.D6: engaging the global level needs a second staff member (p15-d-admin-kill.ts).
  if (input.level === 'global' && input.enabled && !killSwitchState().global.enabled)
    return requestGlobalKill(input.reason.trim());
  return { flag: setFlag(input.level, target, input.enabled) };
});

// ------------------------------------------------------------------ re-drive

interface RedriveBody {
  scope?: 'kill_switch' | 'stuck';
  level?: KillLevel;
  organisationId?: string;
  since?: string;
  stuckMinutes?: number;
  dryRun?: boolean;
  limit?: number;
}

interface Item {
  kind: 'project' | 'publication';
  id: string;
  organisationId: string;
  action: 'resume_planning' | 'resume_assets' | 'retry_publication' | 'reenqueue' | 'skipped';
  jobs?: string[];
  skippedReason?: string;
}

function stillEngaged(h: Halted): KillLevel | null {
  return killSwitchFor({
    organisationId: h.organisationId,
    projectId: h.kind === 'project' ? h.id : undefined,
    provider: h.provider ?? (h.level === 'provider' ? (h.target ?? undefined) : undefined),
    platform: h.platform,
  });
}

function killSwitchItem(h: Halted): Item {
  const engaged = stillEngaged(h);
  const base = { kind: h.kind, id: h.id, organisationId: h.organisationId };
  if (engaged)
    return { ...base, action: 'skipped', skippedReason: `kill_switch_still_engaged: ${engaged}` };
  if (h.stage === 'publish')
    return { ...base, action: 'retry_publication', jobs: [`publish-video:${h.id}`] };
  if (h.stage === 'planning')
    return { ...base, action: 'resume_planning', jobs: [`plan-project:${h.id}`] };
  return {
    ...base,
    action: 'resume_assets',
    jobs: [`generate-shot:${h.id}:3`, `generate-shot:${h.id}:5`, `generate-voice:${h.id}`],
  };
}

const STAGE_JOB: Record<string, string> = {
  PLANNING: 'plan-project',
  GENERATING_ASSETS: 'generate-shot',
  RENDERING: 'render-variant',
};

route('POST', '/admin/redrive', ({ body }) => {
  const input = (body ?? {}) as RedriveBody;
  const scope = input.scope;
  if (scope !== 'kill_switch' && scope !== 'stuck')
    throw new DemoHttpError(400, 'validation_error', 'scope must be kill_switch or stuck');
  const dryRun = input.dryRun !== false;
  const limit = Math.min(500, Math.max(1, input.limit ?? 100));
  const org = input.organisationId?.trim();
  let items: Item[];

  if (scope === 'stuck') {
    if (input.level)
      throw new DemoHttpError(
        400,
        'validation_error',
        'level applies to the kill_switch scope only',
      );
    const minutes = input.stuckMinutes ?? 30;
    if (minutes < 10 || minutes > 10_080)
      throw new DemoHttpError(400, 'validation_error', 'stuckMinutes must be between 10 and 10080');
    const cutoff = Date.now() - minutes * 60_000;
    items = stuckProjects()
      .filter((s) => s.lastMovedAt <= cutoff && (!org || s.organisationId === org))
      .slice(0, limit)
      .map((s): Item => {
        const engaged = killSwitchFor({ organisationId: s.organisationId, projectId: s.id });
        return engaged
          ? {
              kind: 'project',
              id: s.id,
              organisationId: s.organisationId,
              action: 'skipped',
              skippedReason: `kill_switch_still_engaged: ${engaged}`,
            }
          : {
              kind: 'project',
              id: s.id,
              organisationId: s.organisationId,
              action: 'reenqueue',
              jobs: [`${STAGE_JOB[s.state] ?? 'plan-project'}:${s.id}`],
            };
      });
    if (!dryRun) markUnstuck(items.filter((i) => i.action !== 'skipped').map((i) => i.id));
  } else {
    if (!input.since || Number.isNaN(Date.parse(input.since)))
      throw new DemoHttpError(
        400,
        'validation_error',
        'since is required for the kill_switch scope',
      );
    const since = Date.parse(input.since);
    items = haltedWork()
      .filter((h) => !h.redriven && h.failedAt >= since)
      .filter((h) => !input.level || h.level === input.level)
      .filter((h) => !org || h.organisationId === org)
      .sort((a, b) => a.failedAt - b.failedAt)
      .slice(0, limit)
      .map(killSwitchItem);
    if (!dryRun) markRedriven(items.filter((i) => i.action !== 'skipped').map((i) => i.id));
  }

  const skipped = items.filter((i) => i.action === 'skipped').length;
  return {
    dryRun,
    scope,
    counts: { considered: items.length, redriven: items.length - skipped, skipped },
    items,
  };
});
