import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alertAccountProblem,
  alertProvidersExhausted,
  resetAccountAlertCache,
  type AccountAlertDeps,
} from './account-alerts';

// BACKLOG 20.11 — one deduplicated ops alert per provider account problem.

const T0 = Date.parse('2026-09-30T18:00:00Z');

function deps(overrides: Partial<AccountAlertDeps> = {}) {
  const notifyStaff = vi.fn(async () => 1);
  const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
  const d: AccountAlertDeps = {
    notifier: { notifyStaff },
    logger: pino({ level: 'silent' }),
    now: () => T0,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    env: { OPS_ALERT_WEBHOOK_URL: 'https://hooks.slack.invalid/T/B/x' },
    ...overrides,
  };
  return { d, notifyStaff, fetchImpl };
}

const problem = {
  providerId: 'anthropic',
  errorClass: 'account_limit',
  message:
    '400 You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.',
  capability: 'text_generation',
  retryAt: '2026-10-01T00:00:00.000Z',
};

beforeEach(() => resetAccountAlertCache());

describe('alertAccountProblem', () => {
  it('notifies staff once per provider, class and UTC day, and posts the ops webhook', async () => {
    const { d, notifyStaff, fetchImpl } = deps();
    expect(await alertAccountProblem(d, problem)).toBe(true);
    expect(await alertAccountProblem(d, problem)).toBe(false);
    expect(notifyStaff).toHaveBeenCalledTimes(1);
    expect(notifyStaff).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'provider_alert',
        link: '/admin',
        dedupeKey: 'provider-account:anthropic:account_limit:2026-09-30',
        message: {
          key: 'providerAccountProblem',
          params: {
            provider: 'anthropic',
            errorClass: 'account_limit',
            capability: 'text_generation',
            retryAt: '2026-10-01T00:00:00.000Z',
          },
        },
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hooks.slack.invalid/T/B/x');
    expect(JSON.parse(init.body as string).text).toContain('anthropic reached its usage limit');
  });

  it('a different class or provider is a separate alert', async () => {
    const { d, notifyStaff } = deps();
    await alertAccountProblem(d, problem);
    await alertAccountProblem(d, { ...problem, errorClass: 'auth' });
    await alertAccountProblem(d, { ...problem, providerId: 'openai' });
    expect(notifyStaff).toHaveBeenCalledTimes(3);
  });

  it('skips the webhook when another process already created the staff notification', async () => {
    const { d, fetchImpl } = deps({
      notifier: { notifyStaff: vi.fn(async () => 0) },
      env: { OPS_ALERT_WEBHOOK_URL: 'https://hooks.slack.invalid/x', STUDIO_PLATFORM_ORG_IDS: 'o' },
    });
    await alertAccountProblem(d, problem);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws; a failed alert is tried again by the next failure', async () => {
    const notifyStaff = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue(1);
    const { d } = deps({ notifier: { notifyStaff } });
    expect(await alertAccountProblem(d, problem)).toBe(false);
    expect(await alertAccountProblem(d, problem)).toBe(true);
    expect(notifyStaff).toHaveBeenCalledTimes(2);
  });
});

describe('alertProvidersExhausted', () => {
  it('names every provider once', async () => {
    const { d, notifyStaff } = deps({ env: {} });
    const input = {
      capability: 'text_generation',
      failures: [
        { providerId: 'openai', errorClass: 'insufficient_credits' },
        { providerId: 'anthropic', errorClass: 'account_limit' },
      ],
    };
    await alertProvidersExhausted(d, input);
    await alertProvidersExhausted(d, input);
    expect(notifyStaff).toHaveBeenCalledTimes(1);
    expect(notifyStaff).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: 'providers-unavailable:text_generation:anthropic+openai:2026-09-30',
        title:
          'No text_generation provider available: openai (insufficient_credits), anthropic (account_limit)',
      }),
    );
  });
});
