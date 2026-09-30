import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ProviderError } from '../../errors';
import { DEFAULT_LANGUAGE, languageInstruction } from '../languages';
import { calendarDayName, type PlanAngle, type PlanKind } from './mix';

// 20.9 — the month-planning prompt (one Claude call per chunk of slots). The system prompt lives
// in prompts/month-plan.md (copied into the runtime image; the Dockerfile test keeps it there) so
// the operator can read and review it as prose; the rules follow the ideation prompt's
// (pipeline/ideation.ts): never invent prices, offers, claims or quotes; restricted topics are
// never touched; business text is fenced as data. The slots arrive with their format and angle
// already chosen (mix.ts), so the model writes topics only.

export const PLAN_PROMPT_FILE = join('prompts', 'month-plan.md');
/** Slots per Claude call: keeps each answer well under the output limit. */
export const PLAN_CHUNK_SIZE = 20;
export const PLAN_MAX_TOKENS = 8_000;

let cachedSystem: string | undefined;

/** The system prompt (prompts/month-plan.md), read once per process. */
export function planSystemPrompt(root: string = process.cwd()): string {
  if (cachedSystem === undefined || root !== process.cwd())
    cachedSystem = readFileSync(join(root, PLAN_PROMPT_FILE), 'utf8').trim();
  return cachedSystem;
}

export const PLAN_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'title', 'brief', 'hook', 'points', 'cta'],
        properties: {
          index: { type: 'integer', description: 'the slot number' },
          title: { type: 'string' },
          brief: { type: 'string' },
          hook: { type: 'string' },
          points: { type: 'array', items: { type: 'string' } },
          cta: { type: 'string' },
        },
      },
    },
  },
};

export interface PlanBusinessFacts {
  businessName?: string | null;
  industry?: string | null;
  subNiche?: string | null;
  products?: string[];
  services?: string[];
  audienceKeywords?: string[];
  regions?: string[];
  brandVoiceSummary?: string | null;
  toneKeywords?: string[];
  audienceProfile?: string | null;
  restrictedTopics?: string[];
}

export interface PromptSlot {
  /** 1-based slot number within this chunk. */
  index: number;
  /** "Tuesday 6 October 2026" (formatted by the caller in the plan's time zone). */
  dateLabel: string;
  kind: PlanKind;
  angle: PlanAngle;
  calendarDay: string | null;
}

export interface PlanPromptInput {
  facts: PlanBusinessFacts;
  slots: PromptSlot[];
  /** Titles / briefs of the business's recent posts (avoid repeats). */
  recentPosts: string[];
  /** Titles already planned earlier in this plan. */
  plannedTitles: string[];
  styleMemory?: string;
  language?: string;
}

const clean = (s: string) => s.replace(/"""/g, '"').replace(/\s+/g, ' ').trim();
const list = (values: string[] | undefined) =>
  (values ?? []).map(clean).filter(Boolean).slice(0, 30).join(', ');

export function buildPlanPrompt(input: PlanPromptInput): string {
  const f = input.facts;
  const facts = [
    f.industry && `Industry: ${clean(f.industry)}`,
    f.subNiche && `Niche: ${clean(f.subNiche)}`,
    list(f.products) && `Products: ${list(f.products)}`,
    list(f.services) && `Services: ${list(f.services)}`,
    list(f.audienceKeywords) && `Audience: ${list(f.audienceKeywords)}`,
    list(f.regions) && `Regions: ${list(f.regions)}`,
    f.brandVoiceSummary && `Voice: ${clean(f.brandVoiceSummary)}`,
  ].filter(Boolean) as string[];
  const lines = [`Business: ${f.businessName ? clean(f.businessName) : 'not specified'}`];
  lines.push(
    'Business facts:',
    '"""',
    ...(facts.length ? facts : ['No website facts yet: keep posts general to the business.']),
    '"""',
  );
  if (f.toneKeywords?.length) lines.push(`Brand tone: ${list(f.toneKeywords)}`);
  if (f.audienceProfile) lines.push(`Known audience: ${clean(f.audienceProfile)}`);
  if (f.restrictedTopics?.length)
    lines.push(`Restricted topics (never mention): ${list(f.restrictedTopics)}`);
  if (input.recentPosts.length)
    lines.push(
      'Recent posts (do not repeat these topics):',
      '"""',
      ...input.recentPosts.slice(0, 40).map((p) => `- ${clean(p).slice(0, 160)}`),
      '"""',
    );
  if (input.plannedTitles.length)
    lines.push(
      'Already planned this month (do not repeat):',
      ...input.plannedTitles.map((t) => `- ${clean(t).slice(0, 120)}`),
    );
  if (input.styleMemory) lines.push(input.styleMemory);
  lines.push(languageInstruction(input.language ?? DEFAULT_LANGUAGE));
  lines.push('', `Write exactly ${input.slots.length} posts, one per slot, in this order:`);
  for (const s of input.slots) {
    const day = s.calendarDay ? ` (${calendarDayName(s.calendarDay) ?? s.calendarDay})` : '';
    lines.push(
      `${s.index}. ${s.dateLabel} — ${s.kind === 'VIDEO' ? 'video' : 'slideshow'} — angle: ${s.angle}${day}`,
    );
  }
  lines.push(
    '',
    'Return {"items":[{"index","title","brief","hook","points":[],"cta"}]} with one entry per slot number.',
  );
  return lines.join('\n');
}

const cut = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .transform((s) => ([...s].length > max ? `${[...s].slice(0, max - 1).join('')}…` : s));

const itemSchema = z.object({
  index: z.number().int(),
  title: cut(120),
  brief: cut(600),
  hook: cut(120),
  points: z.array(cut(100)).max(12),
  cta: cut(80),
});

const outputSchema = z.object({ items: z.array(itemSchema).max(200) });

export interface PlannedTopic {
  title: string;
  brief: string;
  slides: { hook: string; points: string[]; cta: string };
}

/**
 * Validate one chunk's answer: exactly one usable entry (title and brief) per slot number
 * 1…count, else a retryable ProviderError (the job retries the call).
 */
export function parsePlanResult(json: unknown, count: number): PlannedTopic[] {
  const parsed = outputSchema.safeParse(json);
  if (!parsed.success)
    throw new ProviderError(
      'text_generation',
      'unknown',
      'Month plan output failed validation',
      true,
      {
        issues: parsed.error.issues.slice(0, 5).map((i) => i.message),
      },
    );
  const byIndex = new Map(parsed.data.items.map((item) => [item.index, item]));
  const out: PlannedTopic[] = [];
  for (let i = 1; i <= count; i += 1) {
    const item = byIndex.get(i);
    if (!item || !item.title || !item.brief)
      throw new ProviderError(
        'text_generation',
        'unknown',
        'Month plan output is missing posts',
        true,
        {
          missing: i,
        },
      );
    const points = item.points.filter(Boolean).slice(0, 5);
    out.push({
      title: item.title,
      brief: item.brief,
      slides: {
        hook: item.hook || item.title,
        points: points.length ? points : [item.title],
        cta: item.cta,
      },
    });
  }
  return out;
}
