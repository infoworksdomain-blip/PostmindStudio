import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../../errors';
import { AnthropicAdapter, type AnthropicClientLike } from './anthropic';
import { MODEL_PRICING_USD_PER_MTOK } from './anthropic-models';
import {
  DEFAULT_LIGHT_MODEL,
  modelForTask,
  parseTaskModels,
  TEXT_TASK_TIER,
  TEXT_TASKS,
  textModelsFromEnv,
  type TextTask,
} from './text-tasks';

// 23.2 — per-task Claude model routing.

const LIGHT: readonly TextTask[] = [
  'script_safety',
  'post_copy',
  'hook_line',
  'wall_text',
  'blitz_angles',
  'clip_text_check',
  'slide_image_query',
  'slide_image_check',
];
const STANDARD: readonly TextTask[] = [
  'ideation',
  'script',
  'blitz_cards',
  'month_plan',
  'carousel_thread',
  'slideshow_text',
  'business_profile',
  'library_analysis',
];

const map = { standard: 'claude-sonnet-5', light: DEFAULT_LIGHT_MODEL, overrides: {} };

describe('text task tiers', () => {
  it('puts the light, high-volume calls on the light tier and planning on the standard one', () => {
    for (const task of LIGHT) expect(TEXT_TASK_TIER[task]).toBe('light');
    for (const task of STANDARD) expect(TEXT_TASK_TIER[task]).toBe('standard');
    expect([...LIGHT, ...STANDARD].sort()).toEqual([...TEXT_TASKS].sort());
  });

  it('maps each task to its model; no task = the standard model', () => {
    expect(modelForTask(map, 'script_safety')).toBe('claude-haiku-4-5-20251001');
    expect(modelForTask(map, 'clip_text_check')).toBe('claude-haiku-4-5-20251001');
    expect(modelForTask(map, 'ideation')).toBe('claude-sonnet-5');
    expect(modelForTask(map, 'blitz_cards')).toBe('claude-sonnet-5');
    expect(modelForTask(map, undefined)).toBe('claude-sonnet-5');
  });

  it('a per-task override wins over the tier', () => {
    const withOverride = { ...map, overrides: { script_safety: 'claude-sonnet-5' } };
    expect(modelForTask(withOverride, 'script_safety')).toBe('claude-sonnet-5');
    expect(modelForTask(withOverride, 'post_copy')).toBe(DEFAULT_LIGHT_MODEL);
  });
});

describe('textModelsFromEnv', () => {
  it('defaults the light tier to Claude Haiku 4.5', () => {
    expect(textModelsFromEnv({}, 'claude-sonnet-5')).toEqual({
      standard: 'claude-sonnet-5',
      light: 'claude-haiku-4-5-20251001',
      overrides: {},
    });
  });

  it('reads ANTHROPIC_MODEL, ANTHROPIC_LIGHT_MODEL and ANTHROPIC_TASK_MODELS', () => {
    expect(
      textModelsFromEnv(
        {
          ANTHROPIC_MODEL: 'claude-opus-5',
          ANTHROPIC_LIGHT_MODEL: 'claude-haiku-4-5',
          ANTHROPIC_TASK_MODELS: 'script_safety=claude-sonnet-5, hook_line=claude-opus-5',
        },
        'claude-sonnet-5',
      ),
    ).toEqual({
      standard: 'claude-opus-5',
      light: 'claude-haiku-4-5',
      overrides: { script_safety: 'claude-sonnet-5', hook_line: 'claude-opus-5' },
    });
  });

  it('"off" keeps the light tasks on the standard model (kill switch for the split)', () => {
    expect(textModelsFromEnv({ ANTHROPIC_LIGHT_MODEL: 'off' }, 'claude-sonnet-5').light).toBe(
      'claude-sonnet-5',
    );
  });

  it.each(['nonsense', 'unknown_task=claude-sonnet-5', 'script_safety='])(
    'rejects a malformed ANTHROPIC_TASK_MODELS (%s)',
    (raw) => {
      expect(() => parseTaskModels(raw)).toThrow(ConfigurationError);
    },
  );
});

function message(model: string): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: '{"verdict":"ALLOW"}', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as Anthropic.Message;
}

function adapterWith(create: AnthropicClientLike['messages']['create']) {
  return new AnthropicAdapter({
    client: { messages: { create }, models: { retrieve: vi.fn(async () => ({})) } },
    usdToGbpRate: 1,
  });
}

const base = {
  capability: 'text_generation' as const,
  organisationId: 'org-1',
  system: 'sys',
  prompt: 'p',
  maxTokens: 1_000,
};

describe('AnthropicAdapter per-task model and cost', () => {
  it('sends a light task to Haiku 4.5 and prices it at Haiku rates', async () => {
    const create = vi.fn(async (params: Anthropic.MessageCreateParamsNonStreaming) =>
      message(params.model),
    );
    const adapter = adapterWith(create);
    const submitted = await adapter.submit({ ...base, task: 'script_safety' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
    );
    // Haiku 4.5: $1 / MTok in, $5 / MTok out → 1 + 0.5 = $1.50 → 150p at rate 1.
    expect(submitted.estimatedCostPence).toBe(150);
  });

  it('keeps a standard task on the planning model, priced at its rates', async () => {
    const create = vi.fn(async (params: Anthropic.MessageCreateParamsNonStreaming) =>
      message(params.model),
    );
    const adapter = adapterWith(create);
    const submitted = await adapter.submit({ ...base, task: 'ideation' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-5' }));
    // Sonnet 5: $2 in, $10 out → 2 + 1 = $3 → 300p.
    expect(submitted.estimatedCostPence).toBe(300);
  });

  it('estimates the budget check at the task model price', () => {
    const adapter = adapterWith(vi.fn());
    const light = adapter.estimateCostPence({ ...base, task: 'post_copy' });
    const standard = adapter.estimateCostPence({ ...base, task: 'script' });
    expect(light).toBeLessThan(standard);
  });

  it('refuses an unpriced light model or override at construction', () => {
    const client = { messages: { create: vi.fn() }, models: { retrieve: vi.fn() } };
    expect(
      () =>
        new AnthropicAdapter({ client, usdToGbpRate: 1, lightModel: 'claude-haiku-9-unpriced' }),
    ).toThrow(ConfigurationError);
    expect(
      () =>
        new AnthropicAdapter({
          client,
          usdToGbpRate: 1,
          taskModels: { hook_line: 'claude-unpriced' },
        }),
    ).toThrow(ConfigurationError);
  });

  it('has Haiku 4.5 prices under both its API ID and alias (platform.claude.com pricing)', () => {
    expect(MODEL_PRICING_USD_PER_MTOK['claude-haiku-4-5-20251001']).toEqual({
      input: 1,
      output: 5,
    });
    expect(MODEL_PRICING_USD_PER_MTOK['claude-haiku-4-5']).toEqual({ input: 1, output: 5 });
  });
});
