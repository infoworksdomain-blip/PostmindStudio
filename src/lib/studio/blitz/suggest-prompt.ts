import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ProviderError } from '../../errors';
import { buildPlanPrompt, type PlanBusinessFacts } from '../content-plans/prompt';
import { DEFAULT_LANGUAGE } from '../languages';
import { MAX_PLANNING_OUTPUT_TOKENS } from '../pipeline/token-budgets';
import type { FormatKey } from './formats';

// 22.4 — the Blitz writing prompt (prompts/blitz-suggestions.md, read once per process). One
// Claude call writes up to BLITZ_CARDS_PER_CALL cards of a refill: each card arrives with its
// format, angle, hook framework, whether it may name the business and an optional reference to
// remix, so the model only writes copy. Business text is fenced as data (the month-plan facts
// block is reused).

export const BLITZ_PROMPT_FILE = join('prompts', 'blitz-suggestions.md');
/**
 * Production 2026-10-06: five cards in one 8 000-token answer were truncated. Each call now writes
 * at most three cards with the planning cap (pipeline/token-budgets.ts).
 */
export const BLITZ_MAX_TOKENS = MAX_PLANNING_OUTPUT_TOKENS;
export const BLITZ_CARDS_PER_CALL = 3;

/** The research's hook types (plans/research-fastlane-2026-10-05.md "Copywriting"). */
export const HOOK_TYPES = [
  'call_out',
  'result_first',
  'contrarian',
  'curiosity_gap',
  'mistake',
  'question',
  'story_open',
  'pattern_interrupt',
] as const;
export type HookType = (typeof HOOK_TYPES)[number];

export const MIN_BODY = 3;
export const MAX_BODY = 6;

let cached: string | undefined;

export function blitzSystemPrompt(root: string = process.cwd()): string {
  if (cached === undefined || root !== process.cwd())
    cached = readFileSync(join(root, BLITZ_PROMPT_FILE), 'utf8').trim();
  return cached;
}

export const BLITZ_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['cards'],
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'index',
          'title',
          'hook',
          'body',
          'cta',
          'imageQueries',
          'caption',
          'hashtags',
          'whyItWorks',
        ],
        properties: {
          index: { type: 'integer' },
          title: { type: 'string' },
          hook: { type: 'string' },
          body: { type: 'array', items: { type: 'string' } },
          cta: { type: 'string' },
          imageQueries: { type: 'array', items: { type: 'string' } },
          caption: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } },
          whyItWorks: { type: 'string' },
        },
      },
    },
  },
};

export interface CardRequest {
  index: number;
  format: FormatKey;
  angle: { title: string; description: string; targetAudience: string } | null;
  hookType: HookType;
  mentionBusiness: boolean;
  /** A reference-library video whose structure the card follows (never its words). */
  remix?: { title: string; notes: string } | null;
}

export interface SuggestPromptInput {
  facts: PlanBusinessFacts;
  cards: CardRequest[];
  recentPosts: string[];
  language?: string;
  fixedHashtags?: string[];
  styleMemory?: string;
}

const FORMAT_WORD: Readonly<Record<FormatKey, string>> = {
  carousel: 'carousel',
  slideshow: 'slideshow',
  wall_of_text: 'wall_of_text',
  hook_demo: 'hook_demo',
  ai_video: 'ai_video',
  ugc: 'ugc',
};

const clean = (s: string) => s.replace(/"""/g, '"').replace(/\s+/g, ' ').trim();

export function buildSuggestPrompt(input: SuggestPromptInput): string {
  // Business facts, tone, restricted topics, recent posts, style memory, fixed hashtags and the
  // language line: the month-plan block, without its slot list.
  const business = buildPlanPrompt({
    facts: input.facts,
    slots: [],
    recentPosts: input.recentPosts,
    plannedTitles: [],
    styleMemory: input.styleMemory,
    language: input.language ?? DEFAULT_LANGUAGE,
    fixedHashtags: input.fixedHashtags,
  })
    .split('\nWrite exactly')[0]!
    .trim();
  const lines = [business, '', `Write exactly ${input.cards.length} cards, in this order:`];
  for (const c of input.cards) {
    const angle = c.angle
      ? `angle "${clean(c.angle.title)}"${c.angle.description ? ` (${clean(c.angle.description)})` : ''}${
          c.angle.targetAudience ? ` for ${clean(c.angle.targetAudience)}` : ''
        }`
      : 'any angle that fits the business';
    const remix = c.remix
      ? ` — remix the structure of the reference """${clean(c.remix.title)}: ${clean(c.remix.notes).slice(0, 300)}"""`
      : '';
    lines.push(
      `${c.index}. ${FORMAT_WORD[c.format]} — ${angle} — hook framework: ${c.hookType} — ${
        c.mentionBusiness ? 'may name the business' : 'do not name the business'
      }${remix}`,
    );
  }
  lines.push(
    '',
    'Return {"cards":[{"index","title","hook","body":[],"cta","imageQueries":[],"caption","hashtags":[],"whyItWorks"}]} with one entry per card number.',
  );
  return lines.join('\n');
}

const cut = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .transform((s) => ([...s].length > max ? `${[...s].slice(0, max - 1).join('')}…` : s));

const cardSchema = z.object({
  index: z.number().int(),
  title: cut(80),
  hook: cut(90),
  body: z.array(cut(220)).max(12),
  cta: cut(60),
  imageQueries: z.array(cut(120)).max(12).default([]),
  caption: cut(600),
  hashtags: z.array(z.string().max(120)).max(30).default([]),
  whyItWorks: cut(160),
});

export interface WrittenCard {
  title: string;
  hook: string;
  body: string[];
  cta: string;
  imageQueries: string[];
  caption: string;
  hashtags: string[];
  whyItWorks: string;
}

/**
 * Validate the answer: one usable card (title, hook, ≥ MIN_BODY body lines, a reason) per card
 * number. A card that is missing or unusable is returned as null (that slot fails, the others
 * are kept) — only an answer that does not parse at all is a retryable provider error.
 */
export function parseSuggestResult(json: unknown, count: number): Array<WrittenCard | null> {
  const parsed = z.object({ cards: z.array(z.unknown()).max(50) }).safeParse(json);
  if (!parsed.success)
    throw new ProviderError('text_generation', 'unknown', 'Blitz output failed validation', true);
  const byIndex = new Map<number, WrittenCard>();
  for (const raw of parsed.data.cards) {
    const card = cardSchema.safeParse(raw);
    if (!card.success) continue;
    const body = card.data.body.filter(Boolean).slice(0, MAX_BODY);
    if (!card.data.title || !card.data.hook || body.length < MIN_BODY || !card.data.whyItWorks)
      continue;
    byIndex.set(card.data.index, {
      title: card.data.title,
      hook: card.data.hook,
      body,
      cta: card.data.cta,
      imageQueries: card.data.imageQueries.slice(0, body.length),
      caption: card.data.caption || [card.data.hook, card.data.cta].filter(Boolean).join('\n'),
      hashtags: card.data.hashtags,
      whyItWorks: card.data.whyItWorks,
    });
  }
  return Array.from({ length: count }, (_, i) => byIndex.get(i + 1) ?? null);
}

/** Rotate hook types so a refill never opens two cards the same way. */
export function hookTypeAt(seed: number): HookType {
  return HOOK_TYPES[((seed % HOOK_TYPES.length) + HOOK_TYPES.length) % HOOK_TYPES.length]!;
}
