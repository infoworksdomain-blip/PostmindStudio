import { ApiError } from '@/lib/client/api';

// Response shapes of /api/studio/admin/* (services/kill-switch-admin.ts, services/analytics.ts
// adminCostDashboard, services/library.ts staff endpoints). Kept by hand — the UI never imports
// server modules.

export type KillLevel = 'global' | 'workspace' | 'project' | 'provider';

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
  propagationSec: number;
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

export type LicenseScenario = 'LICENSED' | 'OWNED' | 'SCRAPED';

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
