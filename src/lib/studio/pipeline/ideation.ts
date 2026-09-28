import { z } from 'zod';
import { ProviderError } from '../../errors';
import { DEFAULT_LANGUAGE, languageInstruction } from '../languages';

// Layer 1 — Ideation (spec 5.2): turn the user's words into a concrete brief. If the input is
// unusably vague ("make me a video"), return three concrete direction options instead of
// guessing. Restricted topics from the brand kit are detected here (spec 13.3) so the user can
// confirm before anything is generated.

export interface IdeationContext {
  rawInput: string;
  businessName?: string;
  brand?: {
    toneKeywords: string[];
    audienceProfile?: string | null;
    restrictedTopics: string[];
  };
  targetPlatforms: string[];
  /** Optional steer from the create-project form (spec 8.2 brief.targetAudience / callToAction). */
  hints?: { targetAudience?: string | null; callToAction?: string | null };
  /** 15.C5: BCP 47 language the brief is written in (hook, message, CTA, keywords). */
  language?: string;
}

export const IDEATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'actionable',
    'directionOptions',
    'hook',
    'keyMessage',
    'targetAudience',
    'tone',
    'callToAction',
    'keywords',
    'restrictedTopicsMentioned',
  ],
  properties: {
    actionable: {
      type: 'boolean',
      description: 'false if the input is too vague to produce one clear video',
    },
    directionOptions: {
      type: 'array',
      items: { type: 'string' },
      description: 'exactly 3 concrete directions when actionable is false, otherwise empty',
    },
    hook: { type: 'string', description: 'one-line opening hook, spoken in the first 1.5 seconds' },
    keyMessage: { type: 'string' },
    targetAudience: { type: 'string' },
    tone: { type: 'string', description: "e.g. 'confident, warm, conversational'" },
    callToAction: { type: 'string', description: 'empty string if none fits' },
    keywords: { type: 'array', items: { type: 'string' } },
    restrictedTopicsMentioned: {
      type: 'array',
      items: { type: 'string' },
      description: 'restricted topics from the brand kit that the brief would touch',
    },
  },
} as const;

const ideationResult = z.object({
  actionable: z.boolean(),
  directionOptions: z.array(z.string()),
  hook: z.string(),
  keyMessage: z.string(),
  targetAudience: z.string(),
  tone: z.string(),
  callToAction: z.string(),
  keywords: z.array(z.string()),
  restrictedTopicsMentioned: z.array(z.string()),
});

export type IdeationResult = z.infer<typeof ideationResult>;

export const IDEATION_SYSTEM_PROMPT = [
  'You are the ideation layer of PostMind Studio, which makes short-form and long-form marketing videos for small businesses.',
  "Turn the business owner's request into ONE concrete video brief.",
  'Be specific: a real hook a viewer would stop for, one key message, a clear audience.',
  'If the request is too vague to act on, set actionable=false and give exactly three concrete, different directions the owner could choose from.',
  'Never invent prices, statistics, offers or claims that the request does not contain.',
  'List any restricted topics the brief would touch; do not write the brief around them.',
].join('\n');

export function buildIdeationPrompt(ctx: IdeationContext): string {
  const lines = [
    `Business: ${ctx.businessName ?? 'not specified'}`,
    `Target platforms: ${ctx.targetPlatforms.join(', ')}`,
  ];
  if (ctx.brand) {
    if (ctx.brand.toneKeywords.length)
      lines.push(`Brand tone: ${ctx.brand.toneKeywords.join(', ')}`);
    if (ctx.brand.audienceProfile) lines.push(`Known audience: ${ctx.brand.audienceProfile}`);
    if (ctx.brand.restrictedTopics.length) {
      lines.push(`Restricted topics (never mention): ${ctx.brand.restrictedTopics.join(', ')}`);
    }
  }
  if (ctx.hints?.targetAudience)
    lines.push(`Owner's intended audience: ${ctx.hints.targetAudience}`);
  if (ctx.hints?.callToAction) lines.push(`Owner's call to action: ${ctx.hints.callToAction}`);
  // 15.C5: the brief is written natively in the video's language (keywords and hashtags too).
  lines.push(languageInstruction(ctx.language ?? DEFAULT_LANGUAGE));
  lines.push('', 'Owner request:', '"""', ctx.rawInput.trim(), '"""');
  return lines.join('\n');
}

export function parseIdeationResult(json: unknown): IdeationResult {
  const parsed = ideationResult.safeParse(json);
  if (!parsed.success) {
    throw new ProviderError(
      'text_generation',
      'unknown',
      'Ideation output failed validation',
      true,
      {
        issues: parsed.error.issues.slice(0, 5).map((i) => i.message),
      },
    );
  }
  return parsed.data;
}
