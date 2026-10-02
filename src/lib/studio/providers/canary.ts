import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ConfigurationError } from '../../errors';
import type { AssetStorage } from '../storage';
import { AnthropicAdapter } from './anthropic';
import { AssemblyAiAdapter } from './assemblyai';
import { ElevenLabsAdapter } from './elevenlabs';
import { ElevenLabsMusicAdapter } from './elevenlabs-music';
import { HeyGenAdapter } from './heygen';
import type { ProviderAdapter } from './interface';
import { LumaAdapter } from './luma';
import { OpenAIAdapter } from './openai';
import { RunwayAdapter } from './runway';
import { ShotstackAdapter } from './shotstack';
import { StoryblocksAudioAdapter } from './storyblocks-audio';
import { VeoAdapter } from './veo';
import { SeedanceAdapter } from './seedance';
import { KlingAdapter } from './kling';

// BACKLOG 15.D10 / spec §20 — "Every adapter has integration tests run daily; … staging
// environment monitors deprecation warnings". The daily provider canary
// (.github/workflows/provider-canary.yml → test/canary/providers.canary.ts) builds each adapter
// with a STAGING key and runs the adapter's own healthCheck() — the read-only, unbilled probe
// every adapter already implements (Runway GET /v1/organization, ElevenLabs GET
// /v1/user/subscription, Shotstack GET /templates, …) — through a fetch wrapper that records
// the deprecation signals providers send on responses:
//   Deprecation  RFC 9745 https://www.rfc-editor.org/rfc/rfc9745 (e.g. "@1735689599")
//   Sunset       RFC 8594 https://www.rfc-editor.org/rfc/rfc8594 (an HTTP-date)
//   Link         rel="deprecation" / rel="sunset" (both RFCs) — the provider's migration notes
// Nothing is generated or billed. An adapter whose healthCheck makes no request (no unbilled
// endpoint) is listed in UNPROBED_PROVIDERS and reported as "not probed" rather than healthy
// (none today: Hive, the only one, was removed in 20.21).

export interface DeprecationSignal {
  providerId: string;
  method: string;
  /** Scheme, host and path only — never the query string (it can carry keys). */
  url: string;
  status: number;
  deprecation: string | null;
  sunset: string | null;
  link: string | null;
}

/** Provider id → the staging secret names (GitHub Actions secrets → env). */
export const PROVIDER_CANARY_ENV: Record<string, string[]> = {
  anthropic: ['CANARY_ANTHROPIC_API_KEY'],
  openai: ['CANARY_OPENAI_API_KEY'],
  runway: ['CANARY_RUNWAY_API_KEY'],
  luma: ['CANARY_LUMA_API_KEY'],
  veo: ['CANARY_GOOGLE_GEMINI_API_KEY'],
  seedance: ['CANARY_BYTEPLUS_API_KEY'],
  kling: ['CANARY_KLING_API_KEY'],
  heygen: ['CANARY_HEYGEN_API_KEY', 'CANARY_HEYGEN_AVATAR_ID'],
  elevenlabs: ['CANARY_ELEVENLABS_API_KEY'],
  'elevenlabs-music': ['CANARY_ELEVENLABS_API_KEY'],
  shotstack: ['CANARY_SHOTSTACK_API_KEY'],
  assemblyai: ['CANARY_ASSEMBLYAI_API_KEY'],
  'storyblocks-audio': ['CANARY_STORYBLOCKS_PUBLIC_KEY', 'CANARY_STORYBLOCKS_PRIVATE_KEY'],
};

/** Adapters whose healthCheck() sends no request (reported as not probed). */
export const UNPROBED_PROVIDERS: ReadonlySet<string> = new Set<string>();

function safeUrl(input: string | URL | Request): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '(unparseable url)';
  }
}

function deprecationLink(link: string | null): string | null {
  if (!link) return null;
  return /rel\s*=\s*"?[^";,]*\b(deprecation|sunset)\b/i.test(link) ? link.slice(0, 500) : null;
}

/** Deprecation signals on one response, or null when it carries none. */
export function deprecationSignal(
  providerId: string,
  method: string,
  url: string,
  res: Pick<Response, 'status' | 'headers'>,
): DeprecationSignal | null {
  const deprecation = res.headers.get('deprecation');
  const sunset = res.headers.get('sunset');
  const link = deprecationLink(res.headers.get('link'));
  if (!deprecation && !sunset && !link) return null;
  return {
    providerId,
    method,
    url,
    status: res.status,
    deprecation: deprecation?.slice(0, 200) ?? null,
    sunset: sunset?.slice(0, 200) ?? null,
    link,
  };
}

/** A fetch that passes every call through and records deprecation signals into `sink`. */
export function recordingFetch(
  providerId: string,
  base: typeof fetch,
  sink: DeprecationSignal[],
): typeof fetch {
  return async (input, init) => {
    const res = await base(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const signal = deprecationSignal(providerId, method.toUpperCase(), safeUrl(input), res);
    if (signal) sink.push(signal);
    return res;
  };
}

/** healthCheck() never stores media; any attempt is a bug in the canary, not a provider fault. */
const NO_STORAGE: AssetStorage = {
  put: () => Promise.reject(new ConfigurationError('provider canary: no storage')),
  signedUrl: () => Promise.reject(new ConfigurationError('provider canary: no storage')),
  size: () => Promise.reject(new ConfigurationError('provider canary: no storage')),
  readRange: () => Promise.reject(new ConfigurationError('provider canary: no storage')),
  delete: () => Promise.reject(new ConfigurationError('provider canary: no storage')),
};
const BUCKET = 'provider-canary';
/** Health checks price nothing; the rate only satisfies the constructors. */
const RATE = 0.79;

/** Staging secrets for a provider, or null when any is missing (the check is skipped). */
export function providerCanaryKeys(
  providerId: string,
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  const names = PROVIDER_CANARY_ENV[providerId];
  if (!names) return null;
  const values = names.map((n) => env[n]?.trim() ?? '');
  return values.every(Boolean) ? values : null;
}

/** The adapter for a provider built from its staging keys, calling out through `fetchImpl`. */
export function buildCanaryAdapter(
  providerId: string,
  keys: string[],
  fetchImpl: typeof fetch,
): ProviderAdapter {
  const [key = '', second = ''] = keys;
  const media = { storage: NO_STORAGE, bucket: BUCKET, usdToGbpRate: RATE, fetchImpl };
  switch (providerId) {
    case 'anthropic':
      return new AnthropicAdapter({
        client: new Anthropic({ apiKey: key, fetch: fetchImpl, timeout: 30_000 }),
        usdToGbpRate: RATE,
      });
    case 'openai':
      return new OpenAIAdapter({
        client: new OpenAI({ apiKey: key, fetch: fetchImpl, timeout: 30_000 }),
        storage: NO_STORAGE,
        bucket: BUCKET,
        usdToGbpRate: RATE,
      });
    case 'runway':
      return new RunwayAdapter({ apiKey: key, usdToGbpRate: RATE, fetchImpl });
    case 'luma':
      return new LumaAdapter({ apiKey: key, usdToGbpRate: RATE, fetchImpl });
    case 'veo':
      // healthCheck = models.get on the default Veo model (unbilled).
      return new VeoAdapter({ apiKey: key, usdToGbpRate: RATE, fetchImpl });
    case 'seedance':
      // healthCheck = list one video task (unbilled).
      return new SeedanceAdapter({ apiKey: key, usdToGbpRate: RATE, fetchImpl });
    case 'kling':
      // healthCheck = GET /account/costs (free; documented QPS <= 1).
      return new KlingAdapter({
        credentials: { kind: 'api_key', apiKey: key },
        usdToGbpRate: RATE,
        fetchImpl,
      });
    case 'heygen':
      return new HeyGenAdapter({
        apiKey: key,
        defaultAvatarId: second,
        usdToGbpRate: RATE,
        fetchImpl,
      });
    case 'elevenlabs':
      return new ElevenLabsAdapter({ apiKey: key, ...media });
    case 'elevenlabs-music':
      return new ElevenLabsMusicAdapter({ apiKey: key, ...media });
    case 'shotstack':
      // The staging key belongs to Shotstack's sandbox environment ("stage").
      return new ShotstackAdapter({ apiKey: key, environment: 'stage', fetchImpl });
    case 'assemblyai':
      return new AssemblyAiAdapter({ apiKey: key, usdToGbpRate: RATE, fetchImpl });
    case 'storyblocks-audio':
      return new StoryblocksAudioAdapter({
        publicKey: key,
        privateKey: second,
        storage: NO_STORAGE,
        bucket: BUCKET,
        fetchImpl,
      });
    default:
      throw new ConfigurationError(`No provider canary for ${providerId}`);
  }
}

export interface ProviderCanaryResult {
  providerId: string;
  healthy: boolean;
  probed: boolean;
  reason: string | null;
  deprecations: DeprecationSignal[];
}

/** One provider's daily check: healthCheck() through the recording fetch. */
export async function runProviderCanary(
  providerId: string,
  keys: string[],
  baseFetch: typeof fetch = fetch,
): Promise<ProviderCanaryResult> {
  const deprecations: DeprecationSignal[] = [];
  const adapter = buildCanaryAdapter(
    providerId,
    keys,
    recordingFetch(providerId, baseFetch, deprecations),
  );
  const health = await adapter.healthCheck();
  return {
    providerId,
    healthy: health.healthy,
    probed: !UNPROBED_PROVIDERS.has(providerId),
    reason: health.reason ?? null,
    deprecations,
  };
}

/** GitHub Actions workflow-command lines for a run (::warning for every deprecation signal). */
export function canaryAnnotations(results: ProviderCanaryResult[]): string[] {
  const clean = (s: string) => s.replace(/[\r\n%]/g, ' ');
  return results.flatMap((r) => [
    ...(r.healthy
      ? []
      : [`::error title=Provider canary ${r.providerId}::${clean(r.reason ?? 'unhealthy')}`]),
    ...(r.probed
      ? []
      : [`::notice title=Provider canary ${r.providerId}::not probed (${clean(r.reason ?? '')})`]),
    ...r.deprecations.map(
      (d) =>
        `::warning title=Provider deprecation ${d.providerId}::${d.method} ${d.url} → ` +
        clean(
          [
            d.deprecation && `Deprecation: ${d.deprecation}`,
            d.sunset && `Sunset: ${d.sunset}`,
            d.link && `Link: ${d.link}`,
          ]
            .filter(Boolean)
            .join('; '),
        ),
    ),
  ]);
}
