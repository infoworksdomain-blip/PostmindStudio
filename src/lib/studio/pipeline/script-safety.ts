import { z } from 'zod';
import { ProviderError } from '../../errors';

// Pre-generation script safety (spec 13.2). Every Layer 2 script is classified before any
// Layer 3 spend. BLOCK = never generate; REVIEW = needs a human (no review queue exists yet,
// so REVIEW also stops the run: fail closed); WARN = proceed and log.

export const SAFETY_CATEGORIES = [
  'explicit_sexual',
  'graphic_violence',
  'hate_speech',
  'self_harm',
  'terrorism',
  'election_disinformation',
  'medical_misinformation',
  'financial_scam',
] as const;

export const SCRIPT_SAFETY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'categories', 'reason'],
  properties: {
    verdict: { type: 'string', enum: ['ALLOW', 'WARN', 'REVIEW', 'BLOCK'] },
    categories: { type: 'array', items: { type: 'string', enum: [...SAFETY_CATEGORIES] } },
    reason: { type: 'string' },
  },
} as const;

const safetyResult = z.object({
  verdict: z.enum(['ALLOW', 'WARN', 'REVIEW', 'BLOCK']),
  categories: z.array(z.enum(SAFETY_CATEGORIES)),
  reason: z.string(),
});

export type ScriptSafetyResult = z.infer<typeof safetyResult>;

export const SCRIPT_SAFETY_SYSTEM_PROMPT = [
  'You are a content-safety classifier for marketing video scripts.',
  `Categories: ${SAFETY_CATEGORIES.join(', ')}.`,
  'BLOCK: content that clearly falls in a category (never generate).',
  'REVIEW: plausibly in a category and needs a human decision (e.g. health or financial claims that may mislead).',
  'WARN: borderline but acceptable for ordinary business marketing.',
  'ALLOW: ordinary marketing content.',
  'Judge only the text provided. Be precise; ordinary product promotion is ALLOW.',
].join('\n');

export function buildScriptSafetyPrompt(
  scripts: Array<{ platform: string; fullText: string; onScreenText: string[] }>,
): string {
  return scripts
    .map((s, i) =>
      [
        `Script ${i + 1} (${s.platform}):`,
        s.fullText,
        s.onScreenText.length ? `On-screen text: ${s.onScreenText.join(' | ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

export function parseScriptSafety(json: unknown): ScriptSafetyResult {
  const parsed = safetyResult.safeParse(json);
  if (!parsed.success) {
    throw new ProviderError(
      'text_generation',
      'unknown',
      'Safety classifier output failed validation',
      true,
    );
  }
  return parsed.data;
}

/** True when the run must stop before any asset is generated. */
export function blocksGeneration(result: ScriptSafetyResult): boolean {
  return result.verdict === 'BLOCK' || result.verdict === 'REVIEW';
}
