// Anthropic model prices (no SDK import, so setup checks and env validation can use it).

export const DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * USD per million tokens (Anthropic first-party rates). Add a row before switching models.
 * 23.2: Claude Haiku 4.5 is $1 input / $5 output per MTok under both its API ID
 * (claude-haiku-4-5-20251001) and its alias (claude-haiku-4-5):
 * https://platform.claude.com/docs/en/about-claude/pricing and
 * https://platform.claude.com/docs/en/about-claude/models/overview (both read 2026-10-06).
 */
export const MODEL_PRICING_USD_PER_MTOK: Readonly<
  Record<string, { input: number; output: number }>
> = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
};

export function hasModelPricing(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODEL_PRICING_USD_PER_MTOK, model);
}
