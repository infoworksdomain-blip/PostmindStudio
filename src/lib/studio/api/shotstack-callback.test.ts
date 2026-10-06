import type { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ProviderError, RateLimitError } from '../../errors';
import type { ProviderPollResult } from '../providers/interface';
import { createMemoryProviderWake } from '../providers/provider-wake';
import { createProviderRegistry } from '../providers/registry';
import { renderCallbackFromEnv, renderCallbackUrl } from '../providers/render-callback';
import { StubAdapter } from '../providers/test-adapter';
import type { RateLimiter } from './rate-limit';
import { handleShotstackCallback } from './shotstack-callback';

// BACKLOG 23.1 — the Shotstack render callback route: token auth, unknown renders, replays,
// never trusting the payload (status fetched from Shotstack first), then waking the job.

const ENV = {
  APP_URL: 'https://studio.example.com',
  STUDIO_RENDER_CALLBACK_SECRET: 'k'.repeat(40),
};
const RENDER_ID = '6d7acbe6-e7c1-4cf8-b8ea-94e7522878cc';
const config = renderCallbackFromEnv(ENV)!;

interface JobRow {
  id: string;
  state: string;
  organisationId: string;
  projectId: string | null;
  providerJobId: string;
}

function setup(
  options: {
    rows?: JobRow[];
    poll?: () => Promise<ProviderPollResult>;
    limiter?: RateLimiter;
  } = {},
) {
  const rows = options.rows ?? [
    {
      id: 'pj-1',
      state: 'RUNNING',
      organisationId: 'org-1',
      projectId: 'p-1',
      providerJobId: RENDER_ID,
    },
  ];
  const findFirst = vi.fn(
    async (args: { where: { providerJobId: string; state?: string } }) =>
      rows.find(
        (r) =>
          r.providerJobId === args.where.providerJobId &&
          (args.where.state === undefined || r.state === args.where.state),
      ) ?? null,
  );
  const shotstack = new StubAdapter('shotstack', ['composition']);
  const poll = vi.fn(
    options.poll ??
      (async (): Promise<ProviderPollResult> => ({
        state: 'succeeded',
        output: { url: 'https://cdn.invalid/r.mp4', metadata: {} },
      })),
  );
  shotstack.nextPoll = poll;
  const wake = createMemoryProviderWake();
  const deps = {
    db: { providerJob: { findFirst } } as unknown as PrismaClient,
    registry: createProviderRegistry([shotstack]),
    providerWake: wake,
    webhookRateLimiter: options.limiter,
    logger: pino({ level: 'silent' }),
  };
  const call = (
    url: string,
    body: unknown = { type: 'edit', action: 'render', id: RENDER_ID, status: 'done' },
  ) =>
    handleShotstackCallback(
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      async () => deps,
      ENV,
    );
  return { call, wake, poll, findFirst };
}

describe('POST /api/studio/webhooks/shotstack (23.1)', () => {
  it('a valid callback fetches the status from Shotstack and wakes the job', async () => {
    const { call, wake, poll } = setup();
    const res = await call(renderCallbackUrl(config));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, woken: true });
    expect(poll).toHaveBeenCalledOnce();
    expect(wake.pending()).toEqual([`studio:pwake:shotstack:${RENDER_ID}`]);
  });

  it('a failed render wakes the job too (the worker records the failure)', async () => {
    const { call, wake } = setup({
      poll: async () => ({
        state: 'failed',
        error: { class: 'unknown', message: 'bad edit', retryable: false },
      }),
    });
    expect((await call(renderCallbackUrl(config))).status).toBe(200);
    expect(wake.pending()).toHaveLength(1);
  });

  it('rejects a bad or missing token before reading anything', async () => {
    const { call, wake, findFirst } = setup();
    const url = new URL(renderCallbackUrl(config));
    url.searchParams.set('s', 'A'.repeat(43));
    expect((await call(url.toString())).status).toBe(401);
    expect((await call('https://studio.example.com/api/studio/webhooks/shotstack')).status).toBe(
      401,
    );
    expect(findFirst).not.toHaveBeenCalled();
    expect(wake.pending()).toEqual([]);
  });

  it('answers 404 for a render Studio does not know', async () => {
    const { call, poll } = setup({ rows: [] });
    expect((await call(renderCallbackUrl(config))).status).toBe(404);
    expect(poll).not.toHaveBeenCalled();
  });

  it('a replay after the render was recorded is a no-op (no fetch, no wake)', async () => {
    const { call, wake, poll } = setup({
      rows: [
        {
          id: 'pj-1',
          state: 'SUCCEEDED',
          organisationId: 'org-1',
          projectId: 'p-1',
          providerJobId: RENDER_ID,
        },
      ],
    });
    const res = await call(renderCallbackUrl(config));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'already_recorded' });
    expect(poll).not.toHaveBeenCalled();
    expect(wake.pending()).toEqual([]);
  });

  it('never trusts the payload: "done" while Shotstack says rendering does not wake', async () => {
    const { call, wake } = setup({ poll: async () => ({ state: 'running' }) });
    const res = await call(renderCallbackUrl(config));
    expect(await res.json()).toEqual({ ok: true, ignored: 'still_running' });
    expect(wake.pending()).toEqual([]);
  });

  it('a replayed callback while the job still waits wakes it again (idempotent)', async () => {
    const { call, wake } = setup();
    const url = renderCallbackUrl(config);
    await call(url);
    await call(url);
    expect(wake.pending()).toHaveLength(1);
  });

  it('ignores Serve API callbacks and refuses bodies without a render id', async () => {
    const { call, poll } = setup();
    const serve = await call(renderCallbackUrl(config), {
      type: 'serve',
      action: 'copy',
      id: RENDER_ID,
    });
    expect(await serve.json()).toEqual({ ok: true, ignored: 'not_a_render' });
    expect((await call(renderCallbackUrl(config), { id: 'not-a-uuid' })).status).toBe(400);
    expect((await call(renderCallbackUrl(config), 'not json')).status).toBe(400);
    expect(poll).not.toHaveBeenCalled();
  });

  it('answers 502 when Shotstack cannot be reached, so Shotstack retries the callback', async () => {
    const { call, wake } = setup({
      poll: async () => {
        throw new ProviderError('shotstack', 'timeout', 'timed out', true);
      },
    });
    expect((await call(renderCallbackUrl(config))).status).toBe(502);
    expect(wake.pending()).toEqual([]);
  });

  it('is rate-limited per source address', async () => {
    const limiter: RateLimiter = {
      check: vi.fn(async () => {
        throw new RateLimitError('Too many requests', 30, { scope: 'user' });
      }),
    };
    const { call } = setup({ limiter });
    expect((await call(renderCallbackUrl(config))).status).toBe(429);
  });

  it('is not found when callbacks are off (http APP_URL)', async () => {
    const { findFirst } = setup();
    const res = await handleShotstackCallback(
      new Request(renderCallbackUrl(config), { method: 'POST', body: '{}' }),
      async () => ({
        db: { providerJob: { findFirst } } as unknown as PrismaClient,
        registry: createProviderRegistry([new StubAdapter('shotstack', ['composition'])]),
        providerWake: createMemoryProviderWake(),
        logger: pino({ level: 'silent' }),
      }),
      { ...ENV, APP_URL: 'http://localhost:3010' },
    );
    expect(res.status).toBe(404);
  });
});
