import { ConfigurationError } from '../../errors';

// 20.29 load-test harness — the fake-provider mode is opt-in and refuses production.
//
//   STUDIO_FAKE_PROVIDERS=1                        required: every provider is a simulation
//   STUDIO_FAKE_PROVIDERS_ALLOW_PRODUCTION=yes-…   a SEPARATE opt-in, only for a disposable
//                                                  production-like stack (CI's copy of
//                                                  deploy/vps/compose.yml, which names its env
//                                                  "production"). Never set it on the real server.
//
// Refused when the run looks like the live service: NODE_ENV / STUDIO_ENV production or APP_URL on
// the live domain, unless the separate opt-in is set; and always refused when APP_URL is the live
// domain (that opt-in cannot unlock the real server).

export const FAKE_PROVIDERS_ENV = 'STUDIO_FAKE_PROVIDERS';
export const FAKE_PROVIDERS_ALLOW_PRODUCTION_ENV = 'STUDIO_FAKE_PROVIDERS_ALLOW_PRODUCTION';
export const ALLOW_PRODUCTION_VALUE = 'yes-this-is-a-disposable-stack';
/** The live service's host names: fake providers never run with these. */
export const LIVE_HOSTS: readonly string[] = ['studio.postmindai.pro', 'postmindai.pro'];

type Env = Readonly<Record<string, string | undefined>>;

function hostOf(url: string | undefined): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function fakeProvidersRequested(env: Env = process.env): boolean {
  return env[FAKE_PROVIDERS_ENV]?.trim() === '1';
}

/** Throws ConfigurationError unless fake providers are requested and allowed here. */
export function assertFakeProvidersAllowed(env: Env = process.env): void {
  if (!fakeProvidersRequested(env)) {
    throw new ConfigurationError(`${FAKE_PROVIDERS_ENV}=1 is required for the load-test harness`);
  }
  const host = hostOf(env.APP_URL);
  if (host && LIVE_HOSTS.some((live) => host === live || host.endsWith(`.${live}`))) {
    throw new ConfigurationError(`Fake providers never run against the live service (${host})`);
  }
  const productionLike =
    env.NODE_ENV === 'production' ||
    env.STUDIO_ENV === 'production' ||
    env.SENTRY_ENVIRONMENT === 'production';
  if (productionLike && env[FAKE_PROVIDERS_ALLOW_PRODUCTION_ENV] !== ALLOW_PRODUCTION_VALUE) {
    throw new ConfigurationError(
      `Fake providers refuse a production environment; for a disposable production-like stack set ${FAKE_PROVIDERS_ALLOW_PRODUCTION_ENV}=${ALLOW_PRODUCTION_VALUE}`,
    );
  }
}

/**
 * A fetch that only reaches this machine (127.0.0.1 / localhost / data: URLs). The harness passes
 * it as the pipeline's fetch, so no request can reach a real (paid) provider by accident.
 */
export function localOnlyFetch(inner: typeof fetch = globalThis.fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
    const local =
      parsed.protocol === 'data:' ||
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
    if (!local) throw new ConfigurationError(`load-test harness refused a non-local fetch: ${url}`);
    return inner(input, init);
  }) as typeof fetch;
}
