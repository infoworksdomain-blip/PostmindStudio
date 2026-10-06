import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../errors';
import { PLAN_BATCH_SIZE, PLAN_MAX_TOKENS } from '../content-plans/prompt';
import { MAX_PLANNING_OUTPUT_TOKENS } from '../pipeline/token-budgets';
import { titleKey, writeTopics, type PlanContext, type PlanGenerator } from './content-plan-draft';

// 23.4 — the month-plan writer in batches (production 2026-10-06: 84 posts in 20-post answers hit
// "Output hit max_tokens (8000)" and the month was left with untitled posts).

type Item = Parameters<typeof writeTopics>[2][number];

const plan = { timezone: 'Europe/London', language: 'en-GB', platforms: ['tiktok'] };
const context: PlanContext = { facts: { businessName: 'Sourdough' }, recentPosts: [] };
const DAY = 86_400_000;

function items(n: number): Item[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `item-${i}`,
    slotAt: new Date(Date.UTC(2026, 9, 7) + Math.floor(i / 3) * DAY + (i % 3) * 3_600_000),
    kind: 'CAROUSEL',
    angle: 'how_to',
    calendarDay: null,
  }));
}

/** A fake db that records each item's written title. */
function fakeDb() {
  const titles = new Map<string, string>();
  const db = {
    contentPlanItem: {
      updateMany: (args: { where: { id: string }; data: { title: string } }) => {
        titles.set(args.where.id, args.data.title);
        return Promise.resolve({ count: 1 });
      },
    },
    $transaction: (ops: Array<Promise<unknown>>) => Promise.all(ops),
  };
  return { db: db as unknown as Pick<PrismaClient, 'contentPlanItem' | '$transaction'>, titles };
}

interface Call {
  prompt: string;
  maxTokens: number;
  task: string;
  count: number;
  slotNumbers: number[];
}

/** A writer with distinct titles per call; `fail(n)` makes call n (1-based) throw. */
function writer(options: { fail?: (call: number) => boolean; title?: (n: number) => string } = {}) {
  const calls: Call[] = [];
  let made = 0;
  const generate: PlanGenerator = async (request) => {
    const count = Number(/Write exactly (\d+) posts/.exec(request.prompt)?.[1] ?? 0);
    const slotNumbers = [...request.prompt.matchAll(/^(\d+)\. .* — /gm)].map((m) => Number(m[1]));
    calls.push({
      prompt: request.prompt,
      maxTokens: request.maxTokens,
      task: request.task,
      count,
      slotNumbers,
    });
    const call = calls.length;
    if (options.fail?.(call))
      throw new ProviderError('anthropic', 'output_truncated', 'Output hit max_tokens', true);
    return {
      json: {
        items: Array.from({ length: count }, (_, i) => {
          made += 1;
          return {
            index: i + 1,
            title: options.title?.(made) ?? `Topic number ${made}`,
            brief: 'A short post.',
            hook: 'Hook',
            points: ['a', 'b'],
            cta: 'Order',
            caption: 'Fresh bread',
            hashtags: ['bread'],
          };
        }),
      },
      model: 'fake:model',
    };
  };
  return { generate, calls };
}

describe('23.4 month plan written in batches', () => {
  it('derives a batch size that fits the planning output cap', () => {
    expect(PLAN_MAX_TOKENS).toBe(MAX_PLANNING_OUTPUT_TOKENS);
    expect(PLAN_BATCH_SIZE).toBe(10);
  });

  it('writes an 84-post month in batches of ≤ 10, numbered from 1, all with the planning cap', async () => {
    const { db, titles } = fakeDb();
    const w = writer();
    const result = await writeTopics({ db, generate: w.generate }, plan, items(84), context, [], {
      rounds: 2,
      onlyMissing: true,
    });
    expect(result.written).toBe(84);
    expect(result.missing).toHaveLength(0);
    expect(w.calls).toHaveLength(9);
    for (const c of w.calls) {
      expect(c.count).toBeLessThanOrEqual(PLAN_BATCH_SIZE);
      expect(c.slotNumbers).toEqual(Array.from({ length: c.count }, (_, i) => i + 1));
      expect(c.maxTokens).toBe(MAX_PLANNING_OUTPUT_TOKENS);
      expect(c.task).toBe('month_plan');
    }
    expect(w.calls.reduce((n, c) => n + c.count, 0)).toBe(84);
    // Waves of 3: the 4th batch is told the titles of the first wave.
    expect(w.calls[3]!.prompt).toContain('Already planned this month');
    expect(w.calls[3]!.prompt).toContain('- Topic number 1\n');
    expect(w.calls[3]!.prompt).toContain('- Topic number 30\n');
    expect(w.calls[0]!.prompt).not.toContain('Already planned this month');
    expect(new Set([...titles.values()].map(titleKey)).size).toBe(84);
  });

  it('a failed batch leaves only its own posts unwritten; the next pass retries them', async () => {
    const { db, titles } = fakeDb();
    // Call 2 (second batch) fails; its retry in the second pass succeeds.
    const w = writer({ fail: (n) => n === 2 });
    const result = await writeTopics({ db, generate: w.generate }, plan, items(84), context, [], {
      rounds: 2,
    });
    expect(result.missing).toHaveLength(0);
    expect(titles.size).toBe(84);
    expect(w.calls).toHaveLength(10);
    expect(w.calls[9]!.count).toBe(10);
  });

  it('a batch that fails in every pass is reported missing, the rest are written', async () => {
    const { db, titles } = fakeDb();
    const w = writer({ fail: (n) => n === 2 || n === 10 });
    const result = await writeTopics({ db, generate: w.generate }, plan, items(84), context, [], {
      rounds: 2,
    });
    expect(result.written).toBe(74);
    expect(result.missing.map((i) => i.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `item-${10 + i}`),
    );
    expect(titles.has('item-10')).toBe(false);
    expect(titles.has('item-20')).toBe(true);
    expect(result.lastError).toBeInstanceOf(ProviderError);
  });

  it('throws when nothing at all could be written', async () => {
    const { db } = fakeDb();
    const w = writer({ fail: () => true });
    await expect(
      writeTopics({ db, generate: w.generate }, plan, items(12), context, []),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('rewrites a repeated title in the next pass, told every title so far', async () => {
    const { db, titles } = fakeDb();
    // Post 11 (first of the second batch) repeats post 1; every later answer is unique.
    const w = writer({ title: (n) => (n === 11 ? 'Topic number 1!' : `Topic number ${n}`) });
    const result = await writeTopics({ db, generate: w.generate }, plan, items(20), context, [], {
      rounds: 2,
      parallel: 1,
    });
    expect(result.missing).toHaveLength(0);
    expect(w.calls).toHaveLength(3);
    expect(w.calls[2]!.count).toBe(1);
    expect(w.calls[2]!.prompt).toContain('- Topic number 1\n');
    expect(new Set([...titles.values()].map(titleKey)).size).toBe(20);
  });

  it('normalises titles for the repeat check', () => {
    expect(titleKey('Why Sourdough Needs Patience!')).toBe(
      titleKey('why sourdough  needs patience'),
    );
  });
});
