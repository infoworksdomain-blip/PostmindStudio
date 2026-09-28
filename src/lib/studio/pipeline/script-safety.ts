import { z } from 'zod';
import { ProviderError } from '../../errors';

// Pre-generation script safety (spec 13.2). Every Layer 2 script is classified before any
// Layer 3 spend. BLOCK = never generate; REVIEW = needs a human: since 13.17 the run pauses
// before any asset spend and a Trust & Safety review is opened (pipeline/safety-review.ts);
// WARN = proceed and log.

export const SAFETY_CATEGORIES = [
  'explicit_sexual',
  'graphic_violence',
  'hate_speech',
  'self_harm',
  'terrorism',
  'election_disinformation',
  'medical_misinformation',
  'financial_scam',
  // 15.C6 (spec 18.3): a real, named or identifiable person is never generated unreviewed.
  'public_figure',
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
  'public_figure: the script names, quotes or depicts a real, identifiable individual (a celebrity, politician, athlete, influencer or other public figure; not the business owner speaking about their own business). Any public_figure content is at least REVIEW.',
  // 15.C5: scripts may be in any supported language (languages.ts).
  'Scripts may be written in English, French, Spanish, Arabic, German, Italian, Portuguese, Hindi or Chinese; judge them in their own language with the same standard.',
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
  return escalatePublicFigure(parsed.data);
}

/**
 * 15.C6 (spec 18.3): "includes a real named individual (public figure) triggers a
 * review-required flag automatically". Raised to at least REVIEW in code, so a classifier that
 * tags the category but answers ALLOW or WARN cannot skip the 13.17 review queue.
 */
export function escalatePublicFigure(result: ScriptSafetyResult): ScriptSafetyResult {
  if (!result.categories.includes('public_figure')) return result;
  if (result.verdict === 'REVIEW' || result.verdict === 'BLOCK') return result;
  return {
    ...result,
    verdict: 'REVIEW',
    reason: `Names a real person (public figure): review required. ${result.reason}`.trim(),
  };
}

/** True when the run must stop before any asset is generated (BLOCK fails, REVIEW pauses). */
export function blocksGeneration(result: ScriptSafetyResult): boolean {
  return result.verdict === 'BLOCK' || result.verdict === 'REVIEW';
}

/** REVIEW: pause for a human decision (13.17) instead of failing the run. */
export function needsSafetyReview(result: ScriptSafetyResult): boolean {
  return result.verdict === 'REVIEW';
}
