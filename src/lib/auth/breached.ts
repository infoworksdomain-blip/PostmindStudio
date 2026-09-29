import { createHash } from 'node:crypto';
import type { Logger } from 'pino';

// Phase 18 §5.1 — breached-password check through the Have I Been Pwned range API with
// k-anonymity: only the first 5 hex characters of the SHA-1 are sent
// (https://haveibeenpwned.com/API/v3#SearchingPwnedPasswordsByRange, read 2026-09-29;
// Add-Padding makes every response the same size). Better Auth 1.7.6 ships a haveIBeenPwned
// plugin, but it fails CLOSED (a HIBP outage blocks every sign-up and reset); the plan wants
// fail-open with a log line, so Studio runs its own check in a before-hook (auth/config.ts).

const RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 2_500;

export interface BreachCheckDeps {
  fetchImpl?: typeof fetch;
  logger: Logger;
  timeoutMs?: number;
}

/** true = found in a breach. Any failure answers false (fail open) and logs a warning. */
export async function isPasswordBreached(
  password: string,
  deps: BreachCheckDeps,
): Promise<boolean> {
  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${RANGE_URL}${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'postmind-studio' },
      signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
    });
    if (!res.ok) {
      deps.logger.warn(
        { status: res.status },
        '[auth] HIBP range lookup failed; allowing password',
      );
      return false;
    }
    const body = await res.text();
    for (const line of body.split('\n')) {
      const [hashSuffix, count] = line.trim().split(':');
      if (hashSuffix === suffix && Number(count) > 0) return true;
    }
    return false;
  } catch (err) {
    deps.logger.warn(
      { err: (err as Error).name },
      '[auth] HIBP range lookup failed; allowing password',
    );
    return false;
  }
}
