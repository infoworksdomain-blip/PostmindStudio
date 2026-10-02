// P1 BYOC (operator decision 2026-09-28; spec 6.6 / 12.6 "Enterprise customers may provide
// their own provider API keys"). The providers an organisation may bring its own key for: the
// ones whose adapters default-registry.ts builds from API keys alone. Pure data (no SDK
// imports) so the settings UI can share the list.

export interface ByocProviderInfo {
  /** Credential id (stored in provider_credentials.providerId). */
  readonly id: string;
  readonly label: string;
  /** Registry provider ids the key builds (one key can back several adapters). */
  readonly adapters: readonly string[];
  /** Two-part secrets (Storyblocks: public + private key). */
  readonly secondaryKeyLabel?: string;
  readonly apiKeyLabel?: string;
}

export const BYOC_PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', adapters: ['anthropic'] },
  { id: 'openai', label: 'OpenAI', adapters: ['openai'] },
  { id: 'assemblyai', label: 'AssemblyAI', adapters: ['assemblyai'] },
  { id: 'runway', label: 'Runway', adapters: ['runway'] },
  { id: 'luma', label: 'Luma', adapters: ['luma'] },
  // 20.20: a Gemini API key from Google AI Studio (billing enabled) backs the Veo adapter.
  { id: 'veo', label: 'Google Veo (Gemini API)', adapters: ['veo'] },
  // 20.23: a BytePlus ModelArk API key (ap-southeast-1, Seedance models activated).
  { id: 'seedance', label: 'BytePlus Seedance (ModelArk)', adapters: ['seedance'] },
  { id: 'heygen', label: 'HeyGen', adapters: ['heygen'] },
  { id: 'elevenlabs', label: 'ElevenLabs', adapters: ['elevenlabs', 'elevenlabs-music'] },
  { id: 'shotstack', label: 'Shotstack', adapters: ['shotstack'] },
  {
    id: 'storyblocks',
    label: 'Storyblocks',
    adapters: ['storyblocks-audio', 'storyblocks-music', 'storyblocks-video'],
    apiKeyLabel: 'Public key',
    secondaryKeyLabel: 'Private key',
  },
  { id: 'pexels', label: 'Pexels', adapters: ['pexels-video'] },
] as const satisfies readonly ByocProviderInfo[];

export type ByocProviderId = (typeof BYOC_PROVIDERS)[number]['id'];

export const BYOC_PROVIDER_IDS: readonly ByocProviderId[] = BYOC_PROVIDERS.map((p) => p.id);

export function isByocProviderId(value: string): value is ByocProviderId {
  return (BYOC_PROVIDER_IDS as readonly string[]).includes(value);
}

export function byocProvider(id: ByocProviderId): ByocProviderInfo {
  return BYOC_PROVIDERS.find((p) => p.id === id) as ByocProviderInfo;
}

/** A provider's secret: an API key, plus the private half of a two-part key (Storyblocks). */
export interface ProviderKey {
  apiKey: string;
  secondaryKey?: string;
}

export type ProviderKeyMap = Partial<Record<ByocProviderId, ProviderKey>>;
