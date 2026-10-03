// SystemFlag keys (studio.system_flags). Naming follows the Engagement pattern
// ('engagement.killSwitch', 'engagement.disabledActionType.<type>').
//
// Studio's four kill-switch levels (spec 4.6): global, workspace, project, provider.
// Engagement stores workspace freezes on Core's Organisation table; Studio may not modify Core
// (CLAUDE.md rule 1), so all four levels live in system_flags.

export const FLAG_ON = 'true';
export const FLAG_OFF = 'false';

export const flagKeys = {
  global: () => 'studio.killSwitch',
  workspace: (organisationId: string) => `studio.frozenWorkspace.${organisationId}`,
  project: (projectId: string) => `studio.killedProject.${projectId}`,
  provider: (providerId: string) => `studio.disabledProvider.${providerId}`,
  /** Level 5 (Phase 12): halts publishing to one platform (PLATFORMS in services/catalog.ts). */
  platform: (platform: string) => `studio.kill_switch.platform.${platform}`,
} as const;

// Every external provider named in spec Section 6 (and Addendum A6 for Unsplash, 20.16 for
// Pixabay) that has its own credentials in .env.example. Each gets a level-4 kill-switch entry
// (spec 6.7).
export const PROVIDER_IDS = [
  'anthropic',
  'openai',
  'runway',
  'veo',
  'seedance',
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
  'pixabay',
  'assemblyai',
  'shotstack',
  'creatomate',
  'sightengine',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Seed rows (BACKLOG 1.9): kill switch off, every provider enabled. */
export function defaultSystemFlags(): ReadonlyArray<{ key: string; value: string }> {
  return [
    { key: flagKeys.global(), value: FLAG_OFF },
    ...PROVIDER_IDS.map((id) => ({ key: flagKeys.provider(id), value: FLAG_OFF })),
  ];
}
