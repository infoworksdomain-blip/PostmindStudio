import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { ProviderError, ProvidersUnavailableError } from '../../errors';
import { resetAccountAlertCache } from '../providers/account-alerts';
import { AnthropicAdapter, type AnthropicClientLike } from '../providers/anthropic';
import { createCircuitBreaker } from '../providers/circuit-breaker';
import { KlingAdapter } from '../providers/kling';
import type { ProviderAdapter } from '../providers/interface';
import type { ProviderJobRecord, ProviderJobRepository } from '../providers/job-repository';
import { OpenAIAdapter, type OpenAIClientLike } from '../providers/openai';
import { createProviderRegistry } from '../providers/registry';
import { RunwayAdapter } from '../providers/runway';
import { SeedanceAdapter } from '../providers/seedance';
import { StubAdapter } from '../providers/test-adapter';
import { describeError, isRetryable } from '../queue/workers/runtime';
import { runProvider, type ProviderRunDeps } from './provider-run';

// BACKLOG 20.11 — production 2026-09-30: a website scan failed because Anthropic answered with
// its documented spend-limit 400 (platform.claude.com/docs/en/api/rate-limits, "Setting your own
// spend limit", read 2026-09-30) and the router never tried OpenAI. Account problems now fail
// over inside the same operation, hold the provider, alert the operator once, and — when nothing
// is left — end in a friendly, non-retryable ProvidersUnavailableError.

const T0 = Date.parse('2026-09-30T18:00:00Z');
const REGAIN = '2026-10-01T00:00:00.000Z';

const USAGE_LIMIT_BODY = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message:
      'You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.',
  },
  request_id: 'req_011Studio',
};

interface Row extends ProviderJobRecord {
  errorClass?: string;
  errorMessage?: string;
}

function memoryRepo() {
  const rows: Row[] = [];
  const repo: ProviderJobRepository = {
    async create(job) {
      const row: Row = {
        id: `job-${rows.length + 1}`,
        organisationId: job.organisationId,
        projectId: job.projectId ?? null,
        provider: job.provider,
        providerJobId: null,
        state: 'PENDING',
        startedAt: new Date(T0),
        costPence: 0,
      };
      rows.push(row);
      return row;
    },
    async find(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async markRunning(id, providerJobId, costPence) {
      Object.assign(
        rows.find((r) => r.id === id)!,
        { state: 'RUNNING', providerJobId, costPence },
      );
    },
    async markSucceeded(id, outcome) {
      Object.assign(
        rows.find((r) => r.id === id)!,
        {
          state: 'SUCCEEDED',
          costPence: outcome.costPence,
        },
      );
    },
    async markFailed(id, outcome) {
      Object.assign(
        rows.find((r) => r.id === id)!,
        {
          state: outcome.state ?? 'FAILED',
          errorClass: outcome.errorClass,
          errorMessage: outcome.errorMessage,
          costPence: outcome.costPence ?? 0,
        },
      );
    },
    async recordUsage() {},
  };
  return { repo, rows };
}

function anthropicFailing(): { adapter: AnthropicAdapter; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async () => {
    throw Anthropic.APIError.generate(400, USAGE_LIMIT_BODY, undefined, new Headers());
  });
  const client = {
    messages: { create },
    models: { retrieve: vi.fn() },
  } as unknown as AnthropicClientLike;
  return { adapter: new AnthropicAdapter({ client, usdToGbpRate: 0.75 }), create };
}

function openaiText(create: () => Promise<unknown>): OpenAIAdapter {
  const client = {
    responses: { create: vi.fn(create) },
    audio: { transcriptions: { create: vi.fn() } },
    images: { generate: vi.fn() },
    embeddings: { create: vi.fn() },
    models: { list: vi.fn() },
  } as unknown as OpenAIClientLike;
  return new OpenAIAdapter({
    client,
    storage: memoryStorage().storage,
    bucket: 'assets',
    usdToGbpRate: 0.75,
  });
}

const PROFILE_JSON = '{"industry":"Bakery","confidence":0.9}';

function openaiResponse(): OpenAI.Responses.Response {
  return {
    id: 'resp_1',
    object: 'response',
    model: 'gpt-6-sol',
    status: 'completed',
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: PROFILE_JSON, annotations: [] }],
      },
    ],
    output_text: PROFILE_JSON,
    usage: {
      input_tokens: 1_000,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 1_200,
    },
  } as unknown as OpenAI.Responses.Response;
}

function setup(adapters: ProviderAdapter[]) {
  const { repo, rows } = memoryRepo();
  let now = T0;
  const breaker = createCircuitBreaker(() => now);
  const killSwitch = {
    check: vi.fn(async () => ({ killed: false as const })),
    assertNotKilled: vi.fn(async () => undefined),
  };
  const notifyStaff = vi.fn(async () => 1);
  const deps = {
    registry: createProviderRegistry(adapters),
    breaker,
    killSwitch,
    budget: { hasBudget: async () => true },
    tracking: { repo, killSwitch, breaker, now: () => now },
    config: { providerTimeoutMs: 60_000, providerPollIntervalMs: 1_000 },
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    logger: pino({ level: 'silent' }),
    notifier: { notify: vi.fn(), notifyStaff },
    fetch: vi.fn(),
  } as unknown as ProviderRunDeps;
  return { deps, rows, breaker, notifyStaff, advance: (ms: number) => (now += ms) };
}

const scanRequest = {
  need: { kind: 'capability' as const, capability: 'text_generation' as const },
  planTier: 'STANDARD' as const,
  request: {
    capability: 'text_generation' as const,
    organisationId: 'org-1',
    system: 'Classify the business.',
    prompt: 'Pages: …',
    maxTokens: 2_000,
    outputSchema: {
      type: 'object',
      properties: { industry: { type: 'string' }, confidence: { type: 'number' } },
      required: ['industry', 'confidence'],
      additionalProperties: false,
    },
  },
};

beforeEach(() => resetAccountAlertCache());

describe('runProvider account-problem failover (20.11)', () => {
  it('Anthropic usage-limit 400 → OpenAI answers the same structured request', async () => {
    const anthropic = anthropicFailing();
    const openai = openaiText(async () => openaiResponse());
    const { deps, rows, breaker, notifyStaff } = setup([anthropic.adapter, openai]);

    const run = await runProvider(scanRequest, deps);

    expect(run.decision.providerId).toBe('openai');
    expect((run.output.metadata as { json: unknown }).json).toEqual({
      industry: 'Bakery',
      confidence: 0.9,
    });
    // provider_jobs: one row per provider, each with its own outcome and cost.
    expect(rows).toEqual([
      expect.objectContaining({
        provider: 'anthropic',
        state: 'FAILED',
        errorClass: 'account_limit',
        costPence: 0,
      }),
      expect.objectContaining({ provider: 'openai', state: 'SUCCEEDED' }),
    ]);
    expect(rows[0]?.errorMessage).toContain('You have reached your specified API usage limits');
    // Held until the time Anthropic stated, not just the normal 5 minutes.
    expect(breaker.accountHolds().anthropic).toMatchObject({
      errorClass: 'account_limit',
      until: Date.parse(REGAIN),
    });
    expect(notifyStaff).toHaveBeenCalledTimes(1);
    expect(notifyStaff).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'provider_alert',
        dedupeKey: 'provider-account:anthropic:account_limit:2026-09-30',
        message: expect.objectContaining({ key: 'providerAccountProblem' }),
      }),
    );
  });

  it('while held, later operations skip Anthropic without calling it or alerting again', async () => {
    const anthropic = anthropicFailing();
    const openai = openaiText(async () => openaiResponse());
    const { deps, notifyStaff, advance } = setup([anthropic.adapter, openai]);
    await runProvider(scanRequest, deps);
    advance(60 * 60_000); // an hour later, still before 00:00 UTC
    const second = await runProvider(scanRequest, deps);
    expect(second.decision.candidates).toEqual([
      { providerId: 'anthropic', skipped: 'circuit_open' },
      { providerId: 'openai' },
    ]);
    expect(anthropic.create).toHaveBeenCalledTimes(1);
    expect(notifyStaff).toHaveBeenCalledTimes(1);
  });

  it('both accounts exhausted → ProvidersUnavailableError: friendly, not retried, one ops alert', async () => {
    const anthropic = anthropicFailing();
    // developers.openai.com/api/docs/guides/error-codes (read 2026-09-30): 429 credit_balance_exhausted.
    const openai = openaiText(async () => {
      throw new OpenAI.RateLimitError(
        429,
        {
          code: 'credit_balance_exhausted',
          type: 'insufficient_quota',
          message: 'Your organization has no prepaid credits remaining.',
        },
        undefined,
        new Headers(),
      );
    });
    const { deps, rows, notifyStaff } = setup([anthropic.adapter, openai]);

    const err = await runProvider(scanRequest, deps).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProvidersUnavailableError);
    expect((err as ProvidersUnavailableError).failures).toEqual([
      { providerId: 'anthropic', errorClass: 'account_limit', retryAt: REGAIN },
      { providerId: 'openai', errorClass: 'insufficient_credits' },
    ]);
    expect(isRetryable(err)).toBe(false);
    const reason = describeError(err);
    expect(reason).toMatch(/^service_unavailable: /);
    expect(reason).not.toContain('{');
    expect(reason).not.toContain('usage limits');
    expect(rows.map((r) => [r.provider, r.state, r.errorClass])).toEqual([
      ['anthropic', 'FAILED', 'account_limit'],
      ['openai', 'FAILED', 'insufficient_credits'],
    ]);
    // One alert per provider, plus one naming both when nothing is left.
    const keys = notifyStaff.mock.calls.map((c) => (c as unknown[])[0] as { dedupeKey: string });
    expect(keys.map((k) => k.dedupeKey)).toEqual([
      'provider-account:anthropic:account_limit:2026-09-30',
      'provider-account:openai:insufficient_credits:2026-09-30',
      'providers-unavailable:text_generation:anthropic+openai:2026-09-30',
    ]);
    expect((notifyStaff.mock.calls[2] as unknown[] | undefined)?.[0]).toMatchObject({
      title: expect.stringContaining('anthropic (account_limit), openai (insufficient_credits)'),
    });
  });

  it('video: a Runway auth failure fails over to Luma in the same operation', async () => {
    const runway = new StubAdapter('runway', ['text_to_video'], { costPence: 60 });
    runway.nextSubmit = async () => {
      throw new ProviderError('runway', 'auth', 'The provided API key is not valid.', false, {
        status: 401,
      });
    };
    const luma = new StubAdapter('luma', ['text_to_video'], { costPence: 23 });
    const { deps, breaker } = setup([runway, luma]);
    const run = await runProvider(
      {
        need: { kind: 'shot', visualTreatment: 'AI_CLIP', durationSec: 5 },
        planTier: 'PLUS',
        request: {
          capability: 'text_to_video',
          organisationId: 'org-1',
          prompt: 'bread',
          durationSec: 5,
          aspectRatio: '9:16',
        },
      },
      deps,
    );
    expect(run.decision.providerId).toBe('luma');
    expect(run.decision.candidates).toEqual([
      { providerId: 'seedance', skipped: 'not_configured' },
      { providerId: 'kling', skipped: 'not_configured' },
      { providerId: 'veo', skipped: 'not_configured' },
      { providerId: 'runway', skipped: 'account_unavailable' },
      { providerId: 'luma' },
    ]);
    expect(breaker.accountHolds().runway?.errorClass).toBe('auth');
    expect(run.fetchOutput).toBeUndefined();
  });

  it('video (20.20 / 20.23): Seedance out of credits → Veo, with its download', async () => {
    const seedance = new StubAdapter('seedance', ['text_to_video'], { costPence: 29 });
    seedance.nextSubmit = async () => {
      throw new ProviderError('seedance', 'insufficient_credits', 'overdue balance', false, {
        status: 403,
      });
    };
    const veo = new StubAdapter('veo', ['text_to_video'], { costPence: 45 });
    const download = vi.fn(async () => new Response('mp4'));
    Object.assign(veo, { fetchOutput: download });
    const runway = new StubAdapter('runway', ['text_to_video'], { costPence: 60 });
    const { deps, breaker } = setup([seedance, veo, runway]);
    const run = await runProvider(
      {
        need: { kind: 'shot', visualTreatment: 'AI_CLIP', durationSec: 6 },
        planTier: 'PLUS',
        request: {
          capability: 'text_to_video',
          organisationId: 'org-1',
          prompt: 'bread',
          durationSec: 6,
          aspectRatio: '9:16',
        },
      },
      deps,
    );
    expect(run.decision.providerId).toBe('veo');
    expect(run.decision.candidates).toEqual([
      { providerId: 'seedance', skipped: 'account_unavailable' },
      { providerId: 'kling', skipped: 'not_configured' },
      { providerId: 'veo' },
    ]);
    expect(breaker.accountHolds().seedance?.errorClass).toBe('insufficient_credits');
    expect(runway.submitCalls).toHaveLength(0);
    // Layer 3 downloads Veo's output with Veo's own (keyed) fetch.
    await run.fetchOutput?.('https://generativelanguage.googleapis.com/v1beta/files/x');
    expect(download).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/files/x',
    );
  });

  it('video (20.24): Seedance out of credits and Kling over its account limit → Veo', async () => {
    const seedance = new StubAdapter('seedance', ['text_to_video'], { costPence: 29 });
    seedance.nextSubmit = async () => {
      throw new ProviderError('seedance', 'insufficient_credits', 'overdue balance', false, {
        status: 403,
      });
    };
    const kling = new StubAdapter('kling', ['text_to_video'], { costPence: 32 });
    kling.nextSubmit = async () => {
      throw new ProviderError('kling', 'account_limit', '1100: Abnormal account status', false, {
        status: 429,
      });
    };
    const veo = new StubAdapter('veo', ['text_to_video'], { costPence: 45 });
    const runway = new StubAdapter('runway', ['text_to_video'], { costPence: 60 });
    const { deps, breaker } = setup([seedance, kling, veo, runway]);
    const run = await runProvider(
      {
        need: { kind: 'shot', visualTreatment: 'AI_CLIP', durationSec: 6 },
        planTier: 'STANDARD',
        request: {
          capability: 'text_to_video',
          organisationId: 'org-1',
          prompt: 'bread',
          durationSec: 6,
          aspectRatio: '9:16',
        },
      },
      deps,
    );
    expect(run.decision.providerId).toBe('veo');
    expect(run.decision.candidates).toEqual([
      { providerId: 'seedance', skipped: 'account_unavailable' },
      { providerId: 'kling', skipped: 'account_unavailable' },
      { providerId: 'veo' },
    ]);
    expect(breaker.accountHolds().kling?.errorClass).toBe('account_limit');
    expect(runway.submitCalls).toHaveLength(0);
  });

  // 20.19 — production 2026-10-02: Runway's 400 { error } for an empty credit balance was
  // classified invalid_request, so the clip never moved to Luma and the video failed.
  const RUNWAY_NO_CREDITS = 'You do not have enough credits to run this task.';
  const clipRequest = {
    need: { kind: 'shot' as const, visualTreatment: 'AI_CLIP' as const, durationSec: 5 },
    planTier: 'PLUS' as const,
    request: {
      capability: 'text_to_video' as const,
      organisationId: 'org-1',
      prompt: 'bread',
      durationSec: 5,
      aspectRatio: '9:16' as const,
    },
  };

  it('video: the real Runway adapter "not enough credits" 400 fails over to Luma in the same job', async () => {
    const http = fakeFetch(json({ error: RUNWAY_NO_CREDITS }, 400));
    const runway = new RunwayAdapter({
      apiKey: 'key_x',
      usdToGbpRate: 0.75,
      fetchImpl: http.fetch,
    });
    const luma = new StubAdapter('luma', ['text_to_video'], { costPence: 23 });
    const { deps, breaker, rows } = setup([runway, luma]);
    const run = await runProvider(clipRequest, deps);
    expect(run.decision.providerId).toBe('luma');
    // 20.23 / 20.24: Seedance, Kling and Veo come first but are not configured in this test.
    expect(run.decision.candidates).toEqual([
      { providerId: 'seedance', skipped: 'not_configured' },
      { providerId: 'kling', skipped: 'not_configured' },
      { providerId: 'veo', skipped: 'not_configured' },
      { providerId: 'runway', skipped: 'account_unavailable' },
      { providerId: 'luma' },
    ]);
    expect(breaker.accountHolds().runway?.errorClass).toBe('insufficient_credits');
    expect(rows.find((r) => r.provider === 'runway')).toMatchObject({
      errorClass: 'insufficient_credits',
      errorMessage: RUNWAY_NO_CREDITS,
    });
  });

  it('video (20.24): the real Kling adapter 1102 "resource pack exhausted" fails over to Veo', async () => {
    const http = fakeFetch(
      json({ code: 1102, message: 'Resource pack exhausted', request_id: 'r' }, 429),
    );
    const kling = new KlingAdapter({
      credentials: { kind: 'api_key', apiKey: 'kling_x' },
      usdToGbpRate: 0.75,
      fetchImpl: http.fetch,
    });
    const veo = new StubAdapter('veo', ['text_to_video'], { costPence: 45 });
    const { deps, breaker, rows } = setup([kling, veo]);
    const run = await runProvider(clipRequest, deps);
    expect(run.decision.providerId).toBe('veo');
    expect(run.decision.candidates).toEqual([
      { providerId: 'seedance', skipped: 'not_configured' },
      { providerId: 'kling', skipped: 'account_unavailable' },
      { providerId: 'veo' },
    ]);
    expect(breaker.accountHolds().kling?.errorClass).toBe('insufficient_credits');
    expect(rows.find((r) => r.provider === 'kling')).toMatchObject({
      errorClass: 'insufficient_credits',
      errorMessage: '1102: Resource pack exhausted',
    });
  });

  it('video: a Runway task that FAILED for lack of credits also fails over to Luma', async () => {
    const http = fakeFetch(
      json({ id: 'task-1' }),
      json({ id: 'task-1', status: 'FAILED', failure: RUNWAY_NO_CREDITS, failureCode: null }),
    );
    const runway = new RunwayAdapter({
      apiKey: 'key_x',
      usdToGbpRate: 0.75,
      fetchImpl: http.fetch,
    });
    const luma = new StubAdapter('luma', ['text_to_video'], { costPence: 23 });
    const { deps, breaker } = setup([runway, luma]);
    const run = await runProvider(clipRequest, deps);
    expect(run.decision.providerId).toBe('luma');
    expect(breaker.accountHolds().runway?.errorClass).toBe('insufficient_credits');
  });

  it('video (20.23): Seedance and Veo account problems on PLUS → Runway, then Luma', async () => {
    const seedance = new StubAdapter('seedance', ['text_to_video'], { costPence: 52 });
    seedance.nextSubmit = async () => {
      throw new ProviderError('seedance', 'auth', 'model not activated', false, { status: 404 });
    };
    const veo = new StubAdapter('veo', ['text_to_video'], { costPence: 45 });
    veo.nextSubmit = async () => {
      throw new ProviderError('veo', 'account_limit', 'spend cap', false, { status: 429 });
    };
    const runway = new StubAdapter('runway', ['text_to_video'], { costPence: 60 });
    const luma = new StubAdapter('luma', ['text_to_video'], { costPence: 23 });
    const { deps, breaker } = setup([seedance, veo, runway, luma]);
    const run = await runProvider(clipRequest, deps);
    expect(run.decision.providerId).toBe('runway');
    expect(run.decision.candidates).toEqual([
      { providerId: 'seedance', skipped: 'account_unavailable' },
      { providerId: 'kling', skipped: 'not_configured' },
      { providerId: 'veo', skipped: 'account_unavailable' },
      { providerId: 'runway' },
    ]);
    expect(breaker.accountHolds().seedance?.errorClass).toBe('auth');
    expect(breaker.accountHolds().veo?.errorClass).toBe('account_limit');
    expect(luma.submitCalls).toHaveLength(0);
    // Seedance clips are pre-signed URLs: Layer 3 copies them with a plain fetch.
    expect(run.fetchOutput).toBeUndefined();
  });

  it('video (20.23): Runway and Luma account problems never reach Seedance (it goes first)', async () => {
    const seedance = new StubAdapter('seedance', ['text_to_video'], { costPence: 52 });
    const runway = new StubAdapter('runway', ['text_to_video'], { costPence: 60 });
    runway.nextSubmit = async () => {
      throw new ProviderError('runway', 'auth', 'bad key', false, { status: 401 });
    };
    const { deps } = setup([seedance, runway]);
    const run = await runProvider(clipRequest, deps);
    expect(run.decision.providerId).toBe('seedance');
    expect(runway.submitCalls).toHaveLength(0);
    // runProvider passes the plan tier to the adapter (21.3: every tier → the full Seedance 2.0).
    expect(seedance.submitCalls[0]).toMatchObject({ planTier: 'PLUS' });
  });

  it('video (20.23 / 21.3): Seedance in arrears on STANDARD: 2.0, then Mini, then Luma', async () => {
    const overdue = () =>
      json(
        {
          error: {
            code: 'AccountOverdueError',
            message: 'The request failed because your account has an overdue balance.',
            type: 'Forbidden',
          },
        },
        403,
      );
    // The whole account is overdue: the full model and the Mini fallback are both refused.
    const http = fakeFetch(overdue(), overdue());
    const seedance = new SeedanceAdapter({
      apiKey: 'ark-key',
      usdToGbpRate: 0.75,
      fetchImpl: http.fetch,
    });
    const luma = new StubAdapter('luma', ['text_to_video'], { costPence: 23 });
    const { deps, breaker, rows } = setup([seedance, luma]);
    const run = await runProvider({ ...clipRequest, planTier: 'STANDARD' }, deps);
    expect(run.decision.providerId).toBe('luma');
    expect(run.decision.candidates).toEqual([
      { providerId: 'seedance', skipped: 'account_unavailable' },
      { providerId: 'kling', skipped: 'not_configured' },
      { providerId: 'veo', skipped: 'not_configured' },
      { providerId: 'runway', skipped: 'not_configured' },
      { providerId: 'luma' },
    ]);
    expect(breaker.accountHolds().seedance?.errorClass).toBe('insufficient_credits');
    expect(rows.find((r) => r.provider === 'seedance')).toMatchObject({
      errorClass: 'insufficient_credits',
    });
    expect(http.requests.map((r) => (r.body as { model: string }).model)).toEqual([
      'dreamina-seedance-2-0-260128',
      'dreamina-seedance-2-0-mini-260615',
    ]);
  });

  it('video (21.3): Seedance 2.0 not activated on STANDARD → Mini takes the clip, no failover', async () => {
    const http = fakeFetch(
      json({ error: { code: 'ModelNotOpen', message: 'has not activated the model' } }, 404),
      json({ id: 'cgt-mini-ok' }),
      json({
        id: 'cgt-mini-ok',
        model: 'dreamina-seedance-2-0-mini-260615',
        status: 'succeeded',
        content: { video_url: 'https://ark-out.example/mini.mp4' },
        usage: { completion_tokens: 108_000 },
        resolution: '720p',
      }),
    );
    const seedance = new SeedanceAdapter({
      apiKey: 'ark-key',
      usdToGbpRate: 0.75,
      fetchImpl: http.fetch,
    });
    const kling = new StubAdapter('kling', ['text_to_video'], { costPence: 26 });
    const { deps, breaker } = setup([seedance, kling]);
    const run = await runProvider(
      {
        ...clipRequest,
        planTier: 'STANDARD',
        request: { ...clipRequest.request, resolution: '720p' as const },
      },
      deps,
    );
    expect(run.decision.providerId).toBe('seedance');
    expect(kling.submitCalls).toHaveLength(0);
    expect(breaker.accountHolds().seedance).toBeUndefined();
    // Two submits (2.0 refused, Mini accepted), then the poll.
    expect(http.requests.filter((r) => r.method === 'POST').map((r) => r.body)).toMatchObject([
      { model: 'dreamina-seedance-2-0-260128', resolution: '720p' },
      { model: 'dreamina-seedance-2-0-mini-260615', resolution: '720p' },
    ]);
  });

  it('video (20.23 / 21.3): not activated (ModelNotOpen) on 2.0 and Mini fails over too', async () => {
    const notOpen = () =>
      json({ error: { code: 'ModelNotOpen', message: 'has not activated the model' } }, 404);
    const http = fakeFetch(notOpen(), notOpen());
    const seedance = new SeedanceAdapter({
      apiKey: 'ark-key',
      usdToGbpRate: 0.75,
      fetchImpl: http.fetch,
    });
    const luma = new StubAdapter('luma', ['text_to_video'], { costPence: 23 });
    const { deps, breaker } = setup([seedance, luma]);
    const run = await runProvider({ ...clipRequest, planTier: 'STANDARD' }, deps);
    expect(run.decision.providerId).toBe('luma');
    expect(breaker.accountHolds().seedance?.errorClass).toBe('auth');
  });

  it('video (20.23): a Seedance content refusal does not fail over', async () => {
    const http = fakeFetch(
      json({ error: { code: 'InputTextSensitiveContentDetected', message: 'sensitive' } }, 400),
    );
    const seedance = new SeedanceAdapter({
      apiKey: 'ark-key',
      usdToGbpRate: 0.75,
      fetchImpl: http.fetch,
    });
    const luma = new StubAdapter('luma', ['text_to_video'], { costPence: 23 });
    const { deps } = setup([seedance, luma]);
    await expect(runProvider({ ...clipRequest, planTier: 'STANDARD' }, deps)).rejects.toMatchObject(
      { errorClass: 'content_policy' },
    );
    expect(luma.submitCalls).toHaveLength(0);
  });

  it('does not fail over for problems that are not about the account', async () => {
    const anthropic = new StubAdapter('anthropic', ['text_generation']);
    anthropic.nextSubmit = async () => {
      throw new ProviderError('anthropic', 'rate_limited', 'slow down', true);
    };
    const openai = new StubAdapter('openai', ['text_generation']);
    const { deps } = setup([anthropic, openai]);
    await expect(runProvider(scanRequest, deps)).rejects.toMatchObject({
      errorClass: 'rate_limited',
    });
    expect(openai.submitCalls).toHaveLength(0);
  });
});
