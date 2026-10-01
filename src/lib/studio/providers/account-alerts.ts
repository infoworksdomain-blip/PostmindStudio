import type { Logger } from 'pino';
import type { Notifier } from '../notifications/notifier';

// BACKLOG 20.11 — tell the operator, once, that a provider account needs attention (bad key, no
// credits, usage / spend limit), and once more when a capability has no provider left at all.
// Reuses the existing channels, never spamming them:
//   - staff in-app notification + the outbound notification webhook (notifier.notifyStaff),
//     deduplicated in the database per (provider, error class, UTC day) — every worker and API
//     process shares that key — and in this process by a small cache so repeat failures do not
//     even reach the database;
//   - OPS_ALERT_WEBHOOK_URL (the Slack incoming webhook the VPS health check and backups post
//     to, runbooks/vps-deploy.md; payload {"text": …}) when it is set, only for the call that
//     created the staff notification (or, with no staff organisation configured, the first call
//     in this process);
//   - a structured error log line (Sentry / log search).
// The existing Prometheus alert StudioProviderCircuitOpen also fires while the breaker is held.
// Alerting never throws: a failed alert must not fail the customer's job.

export interface AccountAlertDeps {
  notifier: Pick<Notifier, 'notifyStaff'>;
  logger: Pick<Logger, 'error' | 'warn'>;
  now: () => number;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export interface AccountProblem {
  providerId: string;
  errorClass: string;
  /** The provider's own message (staff only). */
  message: string;
  capability: string;
  /** ISO time the provider said access resumes, if it did. */
  retryAt?: string;
}

const SENT_CACHE_MAX = 500;
const sent = new Set<string>();

/** Test hook: forget what this process already alerted. */
export function resetAccountAlertCache(): void {
  sent.clear();
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function claim(key: string): boolean {
  if (sent.has(key)) return false;
  if (sent.size >= SENT_CACHE_MAX) sent.clear();
  sent.add(key);
  return true;
}

const CLASS_TEXT: Record<string, string> = {
  auth: 'rejected the API key',
  insufficient_credits: 'has no credits left',
  account_limit: 'reached its usage limit',
};

async function postOpsWebhook(deps: AccountAlertDeps, text: string): Promise<void> {
  const url = (deps.env ?? process.env).OPS_ALERT_WEBHOOK_URL?.trim();
  if (!url) return;
  const res = await (deps.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(5_000),
  });
  await res.body?.cancel();
  if (!res.ok) deps.logger.warn({ status: res.status }, 'ops alert webhook refused the alert');
}

async function raise(
  deps: AccountAlertDeps,
  input: {
    dedupeKey: string;
    title: string;
    body: string;
    message: {
      key: 'providerAccountProblem' | 'providersUnavailable';
      params: Record<string, string>;
    };
  },
): Promise<boolean> {
  if (!claim(input.dedupeKey)) return false;
  try {
    const created = await deps.notifier.notifyStaff({
      kind: 'provider_alert',
      title: input.title,
      body: input.body,
      link: '/admin',
      dedupeKey: input.dedupeKey,
      message: input.message,
    });
    // created = 0 with staff organisations configured means another process already alerted.
    if (created > 0 || !(deps.env ?? process.env).STUDIO_PLATFORM_ORG_IDS?.trim()) {
      await postOpsWebhook(deps, `${input.title}\n${input.body}`);
    }
    return true;
  } catch (err) {
    sent.delete(input.dedupeKey); // let the next failure try again
    deps.logger.warn({ err, dedupeKey: input.dedupeKey }, 'provider account alert failed');
    return false;
  }
}

/** One alert per provider, error class and UTC day. Resolves true when this call raised it. */
export async function alertAccountProblem(
  deps: AccountAlertDeps,
  problem: AccountProblem,
): Promise<boolean> {
  deps.logger.error(
    {
      providerId: problem.providerId,
      errorClass: problem.errorClass,
      capability: problem.capability,
      retryAt: problem.retryAt,
      providerMessage: problem.message.slice(0, 1_000),
    },
    'provider account problem: provider held out of routing',
  );
  const what = CLASS_TEXT[problem.errorClass] ?? problem.errorClass;
  const until = problem.retryAt ? ` Access resumes ${problem.retryAt} (provider's word).` : '';
  return raise(deps, {
    dedupeKey: `provider-account:${problem.providerId}:${problem.errorClass}:${utcDay(deps.now())}`,
    title: `${problem.providerId} ${what}`,
    body:
      `${problem.providerId} (${problem.errorClass}) ${what}; Studio fails ${problem.capability} ` +
      `over to the next provider and holds ${problem.providerId} out of routing.${until} ` +
      `Provider said: ${problem.message.slice(0, 500)}. See runbooks/provider-outage.md.`,
    message: {
      key: 'providerAccountProblem',
      params: {
        provider: problem.providerId,
        errorClass: problem.errorClass,
        capability: problem.capability,
        retryAt: problem.retryAt ?? 'none',
      },
    },
  });
}

/** One alert per capability, set of providers and UTC day when nothing is left to fail over to. */
export async function alertProvidersExhausted(
  deps: AccountAlertDeps,
  input: {
    capability: string;
    failures: ReadonlyArray<{ providerId: string; errorClass: string }>;
  },
): Promise<boolean> {
  const names = input.failures.map((f) => `${f.providerId} (${f.errorClass})`).join(', ');
  const ids = input.failures
    .map((f) => f.providerId)
    .sort()
    .join('+');
  deps.logger.error(
    { capability: input.capability, failures: input.failures },
    'every provider for the capability is unavailable (account problems)',
  );
  return raise(deps, {
    dedupeKey: `providers-unavailable:${input.capability}:${ids}:${utcDay(deps.now())}`,
    title: `No ${input.capability} provider available: ${names}`,
    body:
      `Every ${input.capability} provider failed with an account problem: ${names}. Customers see ` +
      `"temporarily unavailable" until one of these accounts is fixed (key, credits or usage ` +
      `limit). See runbooks/provider-outage.md.`,
    message: {
      key: 'providersUnavailable',
      params: { capability: input.capability, providers: names },
    },
  });
}
