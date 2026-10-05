import { z } from 'zod';
import { ProviderError } from '../../errors';
import { DEFAULT_LANGUAGE, languageInstruction } from '../languages';
import {
  SOCIAL_POSTS_JSON_SCHEMA,
  socialCopyPromptLines,
  socialPostSchema,
  type SocialCopyContext,
} from '../hashtags/copy-prompt';

// Layer 1 — Ideation (spec 5.2): turn the user's words into a concrete brief. If the input is
// unusably vague ("make me a video"), return three concrete direction options instead of
// guessing. Restricted topics from the brand kit are detected here (spec 13.3) so the user can
// confirm before anything is generated.
// 20.13: the same call also writes each target platform's caption and hashtag suggestions
// (socialPosts), so a generated video has its post copy without a second Claude call; the
// worker fits them to the platform and the hashtag policy (caption-suggestions.ts).
// 20.18: ideation is decisive. With any topic and a business to anchor it, it picks the best
// direction itself; actionable=false is kept for empty or meaningless requests, and never when
// the owner has already chosen a direction (directionChosen) or was just asked to choose.

export interface IdeationContext {
  rawInput: string;
  businessName?: string;
  /** 20.18: the project's own name (a hint at the topic), when the user gave one. */
  projectName?: string;
  /**
   * 20.18: the owner picked one of the suggested directions or rewrote the brief after being
   * asked (or was asked on the previous run): the brief must be treated as actionable.
   */
  directionChosen?: boolean;
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
  /** 20.13: caption + hashtag instructions (business hashtags, facts, UK moments). */
  social?: SocialCopyContext;
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
    'socialPosts',
  ],
  properties: {
    actionable: {
      type: 'boolean',
      description:
        'false only if the request is empty or meaningless and the business facts give nothing to build on',
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
    socialPosts: SOCIAL_POSTS_JSON_SCHEMA,
  },
} as const;

/**
 * 21.4: the ideation schema for a UGC actor video adds one flag: the request asks the generated
 * actor to be, look like or sound like a real, identifiable person. The run then stops before
 * Layer 2 (ugc/real-person.ts UGC_REAL_PERSON_REASON).
 */
export const UGC_IDEATION_SCHEMA = {
  ...IDEATION_SCHEMA,
  required: [...IDEATION_SCHEMA.required, 'realPersonRequested'],
  properties: {
    ...IDEATION_SCHEMA.properties,
    realPersonRequested: {
      type: 'boolean',
      description:
        'true if the request asks the actor to be, imitate, look like or sound like a real identifiable person (a celebrity, public figure, influencer, or anyone named)',
    },
  },
} as const;

const ideationResult = z.object({
  /** 21.4: only in UGC_IDEATION_SCHEMA answers. */
  realPersonRequested: z.boolean().optional(),
  actionable: z.boolean(),
  directionOptions: z.array(z.string()),
  hook: z.string(),
  keyMessage: z.string(),
  targetAudience: z.string(),
  tone: z.string(),
  callToAction: z.string(),
  keywords: z.array(z.string()),
  restrictedTopicsMentioned: z.array(z.string()),
  // 20.13: optional so an answer without it (older fixtures, a model that skipped it) still
  // parses; the publish path tops the hashtags up from the business and profile instead.
  socialPosts: z.array(socialPostSchema).max(20).optional(),
});

export type IdeationResult = z.infer<typeof ideationResult>;

export const IDEATION_SYSTEM_PROMPT = [
  'You are the ideation layer of PostMind Studio, which makes short-form and long-form marketing videos for small businesses.',
  "Turn the business owner's request into ONE concrete video brief.",
  'Be specific: a real hook a viewer would stop for, one key message, a clear audience.',
  'Be decisive. Short requests are normal: when the request names any topic (for example "space video" or "social media automation platform"), pick the best direction for this business yourself, using the business facts, known audience and brand tone, and set actionable=true.',
  'Set actionable=false only when the request is genuinely empty or meaningless (for example "make a video", "hi", or a single generic word) and there are no business facts to build on. Then give exactly three concrete, different directions the owner could choose from, each one sentence.',
  'If the request says the owner has already chosen a direction, always set actionable=true and return an empty directionOptions list.',
  'Never invent prices, statistics, offers or claims that the request does not contain.',
  'List any restricted topics the brief would touch; do not write the brief around them.',
].join('\n');

/** 20.18: added to the request when the owner already chose (or rewrote) the direction. */
export const DIRECTION_CHOSEN_INSTRUCTION =
  'The owner has already chosen this direction (from earlier suggestions or by rewriting the request). Do not ask again: set actionable=true, leave directionOptions empty and write the best brief you can from it.';

export function buildIdeationPrompt(ctx: IdeationContext): string {
  const lines = [
    `Business: ${ctx.businessName ?? 'not specified'}`,
    ...(ctx.projectName ? [`Project name: ${ctx.projectName}`] : []),
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
  if (ctx.social) lines.push('', ...socialCopyPromptLines(ctx.social));
  if (ctx.directionChosen) lines.push('', DIRECTION_CHOSEN_INSTRUCTION);
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
