// BACKLOG 11.7 — readiness (Engagement 14.14 pattern): 200 only when every dependency the API
// needs answers; 503 otherwise. Checks run in parallel, each with its own timeout, and report
// only up/down + latency (no connection strings or error text leave the service).

export type CheckStatus = 'up' | 'down';

export interface ReadinessCheck {
  name: string;
  run: () => Promise<unknown>;
}

export interface ReadinessReport {
  ok: boolean;
  checks: Record<string, { status: CheckStatus; latencyMs: number }>;
}

export const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function runReadiness(
  checks: ReadinessCheck[],
  options: {
    now?: () => number;
    timeoutMs?: number;
    onFailure?: (name: string, err: unknown) => void;
  } = {},
): Promise<ReadinessReport> {
  const now = options.now ?? Date.now;
  const results = await Promise.all(
    checks.map(async (check) => {
      const started = now();
      try {
        await withTimeout(check.run(), options.timeoutMs ?? CHECK_TIMEOUT_MS);
        return [check.name, { status: 'up' as const, latencyMs: now() - started }] as const;
      } catch (err) {
        options.onFailure?.(check.name, err);
        return [check.name, { status: 'down' as const, latencyMs: now() - started }] as const;
      }
    }),
  );
  return {
    ok: results.every(([, r]) => r.status === 'up'),
    checks: Object.fromEntries(results),
  };
}
