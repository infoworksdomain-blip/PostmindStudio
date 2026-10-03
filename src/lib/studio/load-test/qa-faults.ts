import { ConfigurationError, ProviderError } from '../../errors';
import type { ProviderAdapter } from '../providers/interface';

// 20.31 stubbed full-pipeline run (scripts/qa/pipeline-e2e.ts) — the two fault injectors the run
// adds on top of the 20.29 simulated providers (fake-providers.ts), so nothing here duplicates the
// harness: it only breaks a simulated provider on purpose and answers social platforms with the
// refusal a DUMMY key gets. Both refuse to leave this machine.

export type ProviderFault = 'rate_limited' | 'insufficient_credits';

/** The answer a real provider gives for each fault (class and retry flag as the adapters set them). */
const FAULTS: Readonly<
  Record<ProviderFault, { errorClass: string; retryable: boolean; message: string }>
> = {
  // Seedance / Kling answer HTTP 429: not an account problem, so the job is retried.
  rate_limited: {
    errorClass: 'rate_limited',
    retryable: true,
    message: 'simulated: 429 Too Many Requests',
  },
  // Out of credit: an ACCOUNT problem, so runProvider fails over at once (20.11).
  insufficient_credits: {
    errorClass: 'insufficient_credits',
    retryable: false,
    message: 'simulated: the account has no credits left',
  },
};

export interface FaultCounters {
  /** Submits this wrapper refused. */
  refused: number;
}

/**
 * Wraps a simulated adapter so every submit fails with the fault. Everything else (id,
 * capabilities, cost estimate, latency) is the inner adapter's, so routing and cost estimates see
 * the same provider.
 */
export function withFault(
  inner: ProviderAdapter,
  fault: ProviderFault,
): { adapter: ProviderAdapter; counters: FaultCounters } {
  const counters: FaultCounters = { refused: 0 };
  const { errorClass, retryable, message } = FAULTS[fault];
  const adapter = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'submit') {
        return async () => {
          counters.refused += 1;
          throw new ProviderError(target.providerId, errorClass, message, retryable, {
            simulated: true,
          });
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { adapter, counters };
}

/** Hosts of the social platforms' APIs (publishing and analytics). */
export const SOCIAL_API_HOSTS: readonly string[] = [
  'open.tiktokapis.com',
  'www.googleapis.com',
  'oauth2.googleapis.com',
  'youtube.googleapis.com',
  'api.x.com',
  'api.twitter.com',
  'upload.twitter.com',
  'api.linkedin.com',
  'graph.facebook.com',
];

const LOCAL_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/**
 * The fetch the publishers get in the stubbed run. A social platform answers 401 with its own
 * "access token invalid" JSON, which is what a DUMMY key gets from the real service, so the
 * friendly-failure path runs for real. Local URLs pass through; anything else is refused.
 */
export function dummyKeyPlatformFetch(
  inner: typeof fetch = globalThis.fetch,
  onSocialCall: (host: string) => void = () => undefined,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
    if (parsed.protocol === 'data:' || LOCAL_HOSTS.includes(parsed.hostname))
      return inner(input, init);
    if (SOCIAL_API_HOSTS.includes(parsed.hostname)) {
      onSocialCall(parsed.hostname);
      return new Response(
        JSON.stringify({
          error: {
            code: 'access_token_invalid',
            message: 'The access token is invalid or not found in the request.',
            status: 401,
          },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new ConfigurationError(`stubbed pipeline run refused a non-local fetch: ${url}`);
  }) as typeof fetch;
}
