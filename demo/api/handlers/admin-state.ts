// Kill-switch flags and the work they halted (agent "insight"). Other demo areas can import
// killSwitchFor() to show the same state the Admin Centre reports.
import { DEMO_ORG_ID, PROJECTS, PUBLICATIONS } from '../ids';

export type KillLevel = 'global' | 'workspace' | 'project' | 'provider' | 'platform';

interface Flag {
  on: boolean;
  since: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const t0 = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

export const OTHER_ORGS = {
  bramley: 'org-bramley-florist',
  harrogate: 'org-harrogate-coffee',
  york: 'org-york-yoga',
  kirkstall: 'org-kirkstall-barbers',
  platform: 'org-postmind-platform',
} as const;

const flags = new Map<string, Flag>([
  ['global', { on: false, since: iso(t0 - 18 * HOUR) }],
  [`workspace:${OTHER_ORGS.bramley}`, { on: true, since: iso(t0 - 2 * DAY) }],
  ['provider:pika', { on: true, since: iso(t0 - 3 * DAY) }],
]);

const key = (level: KillLevel, target?: string) =>
  level === 'global' ? 'global' : `${level}:${target ?? ''}`;

export function isEngaged(level: KillLevel, target?: string): boolean {
  return flags.get(key(level, target))?.on ?? false;
}

/** The first engaged level that would stop this work, or null. */
export function killSwitchFor(scope: {
  organisationId?: string;
  projectId?: string;
  provider?: string;
  platform?: string;
}): KillLevel | null {
  if (isEngaged('global')) return 'global';
  if (scope.organisationId && isEngaged('workspace', scope.organisationId)) return 'workspace';
  if (scope.projectId && isEngaged('project', scope.projectId)) return 'project';
  if (scope.provider && isEngaged('provider', scope.provider)) return 'provider';
  if (scope.platform && isEngaged('platform', scope.platform)) return 'platform';
  return null;
}

export function killSwitchState() {
  const list = (level: KillLevel) =>
    [...flags.entries()]
      .filter(([k, f]) => f.on && k.startsWith(`${level}:`))
      .map(([k, f]) => ({ id: k.slice(level.length + 1), since: f.since }))
      .sort((a, b) => b.since.localeCompare(a.since));
  const g = flags.get('global');
  return {
    global: { enabled: g?.on ?? false, since: g?.since ?? null },
    frozenWorkspaces: list('workspace'),
    killedProjects: list('project'),
    disabledProviders: list('provider'),
    disabledPlatforms: list('platform'),
    propagationSec: 30,
  };
}

// ------------------------------------------------------------------ halted work

export interface Halted {
  kind: 'project' | 'publication';
  id: string;
  organisationId: string;
  level: KillLevel;
  target: string | null;
  stage: 'planning' | 'assets' | 'publish';
  provider?: string;
  platform?: string;
  failedAt: number;
  redriven: boolean;
}

const halted: Halted[] = [
  {
    kind: 'project',
    id: 'prj-bramley-mothers-day',
    organisationId: OTHER_ORGS.bramley,
    level: 'workspace',
    target: OTHER_ORGS.bramley,
    stage: 'planning',
    failedAt: t0 - 20 * HOUR,
    redriven: false,
  },
  {
    kind: 'project',
    id: 'prj-harrogate-latte-art',
    organisationId: OTHER_ORGS.harrogate,
    level: 'provider',
    target: 'pika',
    stage: 'assets',
    provider: 'pika',
    failedAt: t0 - 6 * HOUR,
    redriven: false,
  },
  {
    kind: 'project',
    id: 'prj-york-yoga-retreat',
    organisationId: OTHER_ORGS.york,
    level: 'global',
    target: null,
    stage: 'assets',
    failedAt: t0 - 18 * HOUR + 60_000,
    redriven: false,
  },
  {
    kind: 'project',
    id: 'prj-kirkstall-fade-guide',
    organisationId: OTHER_ORGS.kirkstall,
    level: 'global',
    target: null,
    stage: 'planning',
    failedAt: t0 - 18 * HOUR + 90_000,
    redriven: false,
  },
  {
    kind: 'publication',
    id: 'pub-harrogate-reel-0925',
    organisationId: OTHER_ORGS.harrogate,
    level: 'global',
    target: null,
    stage: 'publish',
    platform: 'instagram_reel',
    failedAt: t0 - 18 * HOUR + 120_000,
    redriven: false,
  },
  {
    kind: 'publication',
    id: 'pub-york-tiktok-0926',
    organisationId: OTHER_ORGS.york,
    level: 'global',
    target: null,
    stage: 'publish',
    platform: 'tiktok',
    failedAt: t0 - 17 * HOUR,
    redriven: false,
  },
];

export const haltedWork = (): Halted[] => halted.map((h) => ({ ...h }));

export function markRedriven(ids: string[]) {
  for (const h of halted) if (ids.includes(h.id)) h.redriven = true;
}

const DEMO_PROJECT_IDS: string[] = Object.values(PROJECTS).map((p) => p.id);
const ACTIVE_PROVIDERS = ['runway', 'luma', 'elevenlabs', 'shotstack', 'anthropic'];
const PLATFORM_PUBS: Record<string, string> = {
  tiktok: PUBLICATIONS.ritualTiktokScheduled,
  youtube_short: PUBLICATIONS.ritualShortsScheduled,
};

function haltOnce(item: Omit<Halted, 'failedAt' | 'redriven'>) {
  if (halted.some((h) => h.id === item.id && !h.redriven)) return;
  halted.push({ ...item, failedAt: Date.now(), redriven: false });
}

/** What engaging a level stops in Leeds Sourdough's live work (the RENDERING project, due posts). */
function haltDemoWork(level: KillLevel, target?: string) {
  const loyalty = PROJECTS.loyaltyCard.id;
  const base = { organisationId: DEMO_ORG_ID, level, target: target ?? null };
  if (level === 'global' || (level === 'workspace' && target === DEMO_ORG_ID)) {
    haltOnce({ ...base, kind: 'project', id: loyalty, stage: 'assets' });
    haltOnce({
      ...base,
      kind: 'publication',
      id: PUBLICATIONS.ritualTiktokScheduled,
      stage: 'publish',
      platform: 'tiktok',
    });
  } else if (level === 'project' && target && DEMO_PROJECT_IDS.includes(target)) {
    haltOnce({
      ...base,
      kind: 'project',
      id: target,
      stage: target === PROJECTS.meetTheBakers.id ? 'planning' : 'assets',
    });
  } else if (level === 'provider' && target && ACTIVE_PROVIDERS.includes(target)) {
    haltOnce({ ...base, kind: 'project', id: loyalty, stage: 'assets', provider: target });
  } else if (level === 'platform' && target && PLATFORM_PUBS[target]) {
    haltOnce({
      ...base,
      kind: 'publication',
      id: PLATFORM_PUBS[target] ?? '',
      stage: 'publish',
      platform: target,
    });
  }
}

export function setFlag(level: KillLevel, target: string | undefined, enabled: boolean) {
  const k = key(level, target);
  const flag = { on: enabled, since: new Date().toISOString() };
  flags.set(k, flag);
  if (enabled) haltDemoWork(level, target);
  const flagKey =
    level === 'global'
      ? 'studio.kill_switch.global'
      : level === 'workspace'
        ? `studio.frozenWorkspace.${target}`
        : level === 'project'
          ? `studio.killedProject.${target}`
          : level === 'provider'
            ? `studio.disabledProvider.${target}`
            : `studio.kill_switch.platform.${target}`;
  return { key: flagKey, value: enabled ? 'on' : 'off', updatedAt: flag.since };
}

// ------------------------------------------------------------------ stuck projects

export interface StuckProject {
  id: string;
  organisationId: string;
  state: string;
  lastMovedAt: number;
  redriven: boolean;
}

const stuck: StuckProject[] = [
  {
    id: PROJECTS.loyaltyCard.id,
    organisationId: DEMO_ORG_ID,
    state: 'RENDERING',
    lastMovedAt: t0 - 12 * 60_000,
    redriven: false,
  },
  {
    id: 'prj-york-yoga-classes',
    organisationId: OTHER_ORGS.york,
    state: 'RENDERING',
    lastMovedAt: t0 - 47 * 60_000,
    redriven: false,
  },
  {
    id: 'prj-bramley-wedding-flowers',
    organisationId: OTHER_ORGS.bramley,
    state: 'GENERATING_ASSETS',
    lastMovedAt: t0 - 130 * 60_000,
    redriven: false,
  },
  {
    id: 'prj-kirkstall-new-chair',
    organisationId: OTHER_ORGS.kirkstall,
    state: 'PLANNING',
    lastMovedAt: t0 - 6 * HOUR,
    redriven: false,
  },
];

export const stuckProjects = (): StuckProject[] => stuck.map((s) => ({ ...s }));

export function markUnstuck(ids: string[]) {
  for (const s of stuck)
    if (ids.includes(s.id)) {
      s.redriven = true;
      s.lastMovedAt = Date.now();
    }
}
