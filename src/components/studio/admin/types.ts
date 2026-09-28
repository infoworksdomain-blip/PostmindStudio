import { ApiError } from '@/lib/client/api';

// Response shapes of /api/studio/admin/* (services/kill-switch-admin.ts, services/analytics.ts
// adminCostDashboard, services/library.ts staff endpoints). Kept by hand — the UI never imports
// server modules.

export type KillLevel = 'global' | 'workspace' | 'project' | 'provider' | 'platform';

export interface KillSwitchEntry {
  id: string;
  since: string;
}

export interface KillSwitchState {
  ok: true;
  global: { enabled: boolean; since: string | null };
  frozenWorkspaces: KillSwitchEntry[];
  killedProjects: KillSwitchEntry[];
  disabledProviders: KillSwitchEntry[];
  /** Publishing platforms halted by the platform level (ids from PUBLISH_PLATFORMS). */
  disabledPlatforms: KillSwitchEntry[];
  propagationSec: number;
  /** 15.D6: a global kill waiting for a second staff member (absent in older responses). */
  pendingGlobal?: PendingGlobalKill | null;
  /** 15.D6: break-glass STUDIO_KILL_SWITCH_SINGLE_APPROVER is on (one person engages). */
  singleApprover?: boolean;
}

export interface PendingGlobalKill {
  requestId: string;
  requestedBy: string;
  reason: string;
  requestedAt: string;
  expiresAt: string;
  requestedByYou: boolean;
}

export interface SetKillSwitchBody {
  level: KillLevel;
  target?: string;
  enabled: boolean;
  reason: string;
}

/**
 * Mirror of PROVIDER_IDS in src/lib/studio/system-flags.ts (the PUT validates against it).
 * Keep in sync when a provider is added.
 */
export const PROVIDER_IDS = [
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
] as const;

/** Mirror of PLATFORMS in src/lib/studio/services/catalog.ts (the PUT validates against it). */
export const PUBLISH_PLATFORMS = [
  'tiktok',
  'instagram_reel',
  'youtube_short',
  'youtube',
  'linkedin_video',
  'x',
  'facebook',
  // 15.A1: the eight destinations incl. Instagram feed and Facebook feed video (catalog PLATFORMS).
  'instagram_feed',
  'facebook_feed',
] as const;

/** POST /admin/redrive body and response (services/redrive.ts). */
export interface RedriveBody {
  scope: 'kill_switch' | 'stuck';
  level?: KillLevel;
  organisationId?: string;
  since?: string;
  stuckMinutes?: number;
  dryRun: boolean;
  limit?: number;
}

export interface RedriveItem {
  kind: 'project' | 'publication';
  id: string;
  organisationId: string;
  action: 'resume_planning' | 'resume_assets' | 'retry_publication' | 'reenqueue' | 'skipped';
  jobs?: string[];
  skippedReason?: string;
}

export interface RedriveResponse {
  ok: true;
  dryRun: boolean;
  scope: RedriveBody['scope'];
  counts: { considered: number; redriven: number; skipped: number };
  items: RedriveItem[];
}

export interface AdminCostRow {
  day: string;
  organisationId: string;
  provider: string;
  jobs: number;
  succeeded: number;
  failed: number;
  costPence: number;
}

export interface AdminCostResponse {
  ok: true;
  days: number;
  data: AdminCostRow[];
}

export type LicenseScenario = 'LICENSED' | 'OWNED' | 'SCRAPED' | 'NOT_REQUIRED';

export type IngestRunState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'DUPLICATE' | 'FAILED';

/** GET /admin/library/ingest/status (corpus ingestion monitoring). */
export interface IngestStatusResponse {
  ok: true;
  windowHours: number;
  since: string;
  counts: Record<IngestRunState, number>;
  total: number;
  completedPerHour: number;
  backlog: { queued: number; running: number };
  liveLibraryItems: number;
  recentFailures: Array<{
    runId: string;
    sourceUrl: string;
    sourceRef: string | null;
    errorReason: string | null;
    attempts: number;
    finishedAt: string | null;
  }>;
}

export interface IngestItem {
  sourceUrl: string;
  licenseScenario: LicenseScenario;
  licenseSource?: string;
  category?: string;
  tags: string[];
  title?: string;
  sourcePlatform?: string;
}

export interface IngestResponse {
  ok: true;
  queued: Array<{ sourceUrl: string; jobId: string }>;
}

export interface LibraryPatchBody {
  title?: string;
  description?: string | null;
  category?: string;
  tags?: string[];
  licenseScenario?: LicenseScenario;
  licenseSource?: string | null;
}

/** 403 from requirePlatformStaff (or a missing capability): the caller isn't PostMind staff. */
export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}
