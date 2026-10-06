import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError, QuotaExceededError } from '../../src/lib/errors';
import { MAX_PLANNING_OUTPUT_TOKENS } from '../../src/lib/studio/pipeline/token-budgets';
import { BLITZ_DAILY_RENDER_CAP, BLITZ_QUEUE_SIZE } from '../../src/lib/studio/blitz/constants';
import { InlineJobQueue } from '../../src/lib/studio/queue/enqueue';
import { createAngle, suggestAngles, updateAngle } from '../../src/lib/studio/services/angles';
import { decide, getDeck } from '../../src/lib/studio/services/blitz';
import { refillBlitzQueue } from '../../src/lib/studio/services/blitz-refill';
import { getMix, putMix } from '../../src/lib/studio/services/content-mix';
import type { PlanGenerator } from '../../src/lib/studio/services/content-plan-draft';
import { monthlyVideoUsage, tierQuota } from '../../src/lib/studio/services/plan-quotas';
import { monthWindow } from '../../src/lib/studio/services/tier-gates';
import { memoryStorage } from '../helpers/memory-storage';
import { tenant } from '../helpers/api-harness';

// 22.4 Blitz on Postgres: angles, the suggestion queue (refill, caps, kill switch, duplicates,
// pre-made vs preview), the allowance (a card counts when kept, not when shown) and the swipe.

const hasDb = Boolean(process.env.DATABASE_URL);
const logger = pino({ level: 'silent' });

/** Writes as many cards as the prompt asks for, each on a fresh topic unless `repeat`. */
function fakeGenerator(options: { repeat?: boolean } = {}): PlanGenerator & { calls: number } {
  const fn = (async (request) => {
    fn.calls += 1;
    if (request.prompt.includes('Suggest exactly')) {
      return {
        json: {
          angles: [
            {
              title: 'Weekend bakes',
              description: 'Ideas for Saturday',
              targetAudience: 'families',
            },
            {
              title: 'Starter care',
              description: 'Keeping a starter alive',
              targetAudience: 'home bakers',
            },
          ],
        },
        model: 'fake',
      };
    }
    const count = Number(/Write exactly (\d+) cards/.exec(request.prompt)?.[1] ?? 0);
    return {
      json: {
        cards: Array.from({ length: count }, (_, i) => {
          // Distinct words per card (fingerprints compare meaningful words).
          const word = () => `w${randomUUID().replace(/-/g, '').slice(0, 10)}`;
          const topic = options.repeat ? 'same sourdough topic' : `${word()} ${word()} ${word()}`;
          return {
            index: i + 1,
            title: topic,
            hook: options.repeat ? 'same sourdough hook' : `${word()} ${word()}`,
            body: [`Point one ${topic}`, 'Point two', 'Point three'],
            cta: 'Order today',
            imageQueries: ['bread', 'oven', 'flour'],
            caption: `Hook for ${topic}`,
            hashtags: ['bread'],
            whyItWorks: 'A call-out hook names the audience in the first second.',
          };
        }),
      },
      model: 'fake',
    };
  }) as PlanGenerator & { calls: number };
  fn.calls = 0;
  return fn;
}

describe.skipIf(!hasDb)('22.4 Blitz', { timeout: 180_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `db-p22-${randomUUID()}`;
  const owner = tenant(org);
  let biz: string;
  let queue: InlineJobQueue;
  const scope = () => ({ organisationId: org, businessId: biz });
  const refillScope = () => ({ ...scope(), userId: 'user-1', planTier: 'STANDARD' as const });
  const refillDeps = (generate: PlanGenerator, extra: Record<string, unknown> = {}) => ({
    db,
    queue,
    logger,
    now: Date.now,
    generate,
    rand: () => 0.1,
    ...extra,
  });
  const apiDeps = () => ({
    db,
    queue,
    storage: memoryStorage().storage,
    logger,
    now: Date.now,
    audit: () => undefined,
  });

  beforeEach(async () => {
    queue = new InlineJobQueue();
    biz = `biz-${randomUUID().slice(0, 8)}`;
    await db.business.create({
      // Business names are unique per organisation (lower(name) index).
      data: {
        id: biz,
        organisationId: org,
        name: `Leeds Sourdough ${biz}`,
        createdByUserId: 'user-1',
      },
    });
  });

  afterAll(async () => {
    const ids = (
      await db.videoProject.findMany({ where: { organisationId: org }, select: { id: true } })
    ).map((p) => p.id);
    await db.slideshowSlide.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.blitzSuggestion.deleteMany({ where: { organisationId: org } });
    await db.contentAngle.deleteMany({ where: { organisationId: org } });
    await db.contentMixPreference.deleteMany({ where: { organisationId: org } });
    await db.business.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  it('angles: unique titles, retire / restore, AI suggestions never repeat a title', async () => {
    const a = await createAngle(db, scope(), 'user-1', {
      title: 'Weekend bakes',
      description: '',
      targetAudience: '',
      weight: 50,
    });
    await expect(
      createAngle(db, scope(), 'user-1', {
        title: 'weekend   BAKES!',
        description: '',
        targetAudience: '',
        weight: 10,
      }),
    ).rejects.toThrow(/already exists/);
    const retired = await updateAngle(db, scope(), a.id, { retired: true }, Date.now());
    expect(retired.retiredAt).not.toBeNull();
    await updateAngle(db, scope(), a.id, { retired: false, weight: 80 }, Date.now());
    const created = await suggestAngles(
      { db, generate: fakeGenerator(), now: Date.now },
      scope(),
      'user-1',
      5,
    );
    // "Weekend bakes" already exists: only "Starter care" is new.
    expect(created.map((c) => c.title)).toEqual(['Starter care']);
    expect(created[0]?.source).toBe('ai');
  });

  it('refill: N cards, pre-made ones rendered (hidden, uncounted), preview ones never generated', async () => {
    await putMix(db, scope(), 'user-1', {
      formatWeights: { carousel: 50, slideshow: 0, ai_video: 50 },
    });
    const generate = fakeGenerator();
    const rand = (() => {
      let n = 0;
      // Alternate low / high: carousel, ai_video, …
      return () => (n++ % 2 === 0 ? 0.1 : 0.9);
    })();
    const result = await refillBlitzQueue(refillDeps(generate, { rand }), refillScope());
    expect(result.created).toBe(BLITZ_QUEUE_SIZE);
    const cards = await db.blitzSuggestion.findMany({ where: scope() });
    const premade = cards.filter((c) => c.format === 'carousel');
    const preview = cards.filter((c) => c.format === 'ai_video');
    expect(premade.length).toBeGreaterThan(0);
    expect(preview.length).toBeGreaterThan(0);
    expect(premade.every((c) => c.status === 'RENDERING' && c.projectId)).toBe(true);
    expect(preview.every((c) => c.status === 'READY' && c.projectId === null)).toBe(true);
    // Only the pre-made cards started a pipeline run (low-priority batch jobs).
    const runs = queue.pending.filter((j) => j.name === 'plan-project');
    expect(runs).toHaveLength(premade.length);
    expect(runs.every((j) => (j.data as { batch?: boolean }).batch === true)).toBe(true);
    const projects = await db.videoProject.findMany({ where: { organisationId: org } });
    expect(projects.every((p) => p.sourceRef?.startsWith('blitz:'))).toBe(true);
    expect(projects.every((p) => p.sourceType === 'CAROUSEL')).toBe(true);
    // A card counts when it is kept, not when it is shown.
    const quota = tierQuota('STANDARD');
    const usage = await monthlyVideoUsage(db, org, quota, monthWindow(Date.now()));
    expect(usage.short).toBe(0);
    // A full deck is not refilled again.
    expect((await refillBlitzQueue(refillDeps(generate), refillScope())).created).toBe(0);
  });

  it('refill: cards are written at most three per call with the planning token cap (production 2026-10-06)', async () => {
    await putMix(db, scope(), 'user-1', {
      formatWeights: { carousel: 0, slideshow: 0, ai_video: 100 },
    });
    const seen: Array<{ cards: number; maxTokens: number | undefined }> = [];
    const inner = fakeGenerator();
    const generate = (async (request) => {
      const cards = Number(/Write exactly (\d+) cards/.exec(request.prompt)?.[1] ?? 0);
      if (cards) {
        seen.push({ cards, maxTokens: request.maxTokens });
        // Every batch is numbered from 1.
        expect(request.prompt).toMatch(/\n1\. /);
        expect(request.prompt).not.toMatch(new RegExp(`\\n${cards + 1}\\. `));
      }
      return inner(request);
    }) as PlanGenerator;
    const result = await refillBlitzQueue(refillDeps(generate), refillScope());
    expect(result.created).toBe(BLITZ_QUEUE_SIZE);
    expect(seen.map((s) => s.cards)).toEqual([3, BLITZ_QUEUE_SIZE - 3]);
    expect(seen.every((s) => s.maxTokens === MAX_PLANNING_OUTPUT_TOKENS)).toBe(true);
  });

  it('refill: a batch that fails leaves the other cards (only an all-batch failure throws)', async () => {
    await putMix(db, scope(), 'user-1', {
      formatWeights: { carousel: 0, slideshow: 0, ai_video: 100 },
    });
    const inner = fakeGenerator();
    let call = 0;
    const generate = (async (request) => {
      if (/Write exactly \d+ cards/.test(request.prompt) && call++ === 0)
        throw new ProviderError('anthropic', 'output_truncated', 'Output hit max_tokens', false);
      return inner(request);
    }) as PlanGenerator;
    const result = await refillBlitzQueue(refillDeps(generate), refillScope());
    expect(result.created).toBe(BLITZ_QUEUE_SIZE - 3);
    expect(result.failed).toBe(3);
    const failing = (async (request) => {
      if (/Write exactly \d+ cards/.test(request.prompt))
        throw new ProviderError('anthropic', 'output_truncated', 'Output hit max_tokens', false);
      return inner(request);
    }) as PlanGenerator;
    await db.blitzSuggestion.deleteMany({ where: scope() });
    await expect(refillBlitzQueue(refillDeps(failing), refillScope())).rejects.toThrow(
      /max_tokens/,
    );
  });

  it('refill: duplicates of recent cards are rejected (no_unique_content)', async () => {
    await putMix(db, scope(), 'user-1', {
      formatWeights: { carousel: 0, slideshow: 0, ai_video: 100 },
    });
    const generate = fakeGenerator({ repeat: true });
    const result = await refillBlitzQueue(refillDeps(generate), refillScope());
    expect(result.created).toBe(1);
    expect(result.duplicates).toBe(BLITZ_QUEUE_SIZE - 1);
    const failed = await db.blitzSuggestion.count({
      where: { ...scope(), status: 'FAILED', failureReason: 'no_unique_content' },
    });
    expect(failed).toBe(BLITZ_QUEUE_SIZE - 1);
  });

  it('refill: kill switch and the daily render cap pause pre-made cards', async () => {
    const generate = fakeGenerator();
    const killed = await refillBlitzQueue(
      refillDeps(generate, { killSwitch: { check: async () => ({ killed: true }) } }),
      refillScope(),
    );
    expect(killed.paused).toBe('kill_switch');
    expect(generate.calls).toBe(0);
    // The day's renders are used up: only pre-made formats are on, so nothing is made.
    await db.blitzSuggestion.createMany({
      data: Array.from({ length: BLITZ_DAILY_RENDER_CAP }, () => ({
        ...scope(),
        format: 'carousel',
        status: 'SKIPPED' as const,
        copy: {},
        whyItWorks: 'x',
        fingerprint: randomUUID(),
        projectId: `prj-${randomUUID()}`,
      })),
    });
    const capped = await refillBlitzQueue(refillDeps(generate), refillScope());
    expect(capped.paused).toBe('caps');
    expect(generate.calls).toBe(0);
    const deck = await getDeck(apiDeps(), owner, biz);
    expect(deck.paused).toBe('caps');
    expect(deck.caps.rendersLeftToday).toBe(0);
  });

  it('skip with a reason nudges the mix (bounded) and archives the render', async () => {
    await refillBlitzQueue(refillDeps(fakeGenerator()), refillScope());
    const card = await db.blitzSuggestion.findFirstOrThrow({
      where: { ...scope(), status: 'RENDERING' },
    });
    await db.blitzSuggestion.update({ where: { id: card.id }, data: { status: 'READY' } });
    const result = await decide(apiDeps(), owner, card.id, {
      action: 'skip',
      reason: 'not_my_style',
    });
    expect(result.notice).toEqual({ kind: 'fewer_format', format: card.format });
    const project = await db.videoProject.findUniqueOrThrow({ where: { id: card.projectId! } });
    expect(project.deletedAt).not.toBeNull();
    const mix = await getMix(db, scope());
    expect(mix.adjustments.formats[card.format as 'carousel']).toBe(-5);
    await expect(decide(apiDeps(), owner, card.id, { action: 'skip' })).rejects.toThrow(
      /already swiped/,
    );
  });

  it('keep reserves the allowance like generate; over the allowance the card stays in the deck', async () => {
    await refillBlitzQueue(refillDeps(fakeGenerator()), refillScope());
    const [first, second] = await db.blitzSuggestion.findMany({
      where: { ...scope(), status: 'RENDERING' },
      take: 2,
    });
    for (const c of [first!, second!]) {
      await db.blitzSuggestion.update({ where: { id: c.id }, data: { status: 'READY' } });
      await db.videoProject.update({
        where: { id: c.projectId! },
        data: { state: 'READY_FOR_REVIEW' },
      });
    }
    const kept = await decide(apiDeps(), owner, first!.id, { action: 'keep', mode: 'edit' });
    expect(kept.publish).toBe('edit');
    const project = await db.videoProject.findUniqueOrThrow({ where: { id: first!.projectId! } });
    expect(project.sourceRef).toBeNull();
    expect((project.metadata as { blitz?: { state?: string } }).blitz?.state).toBe('kept');
    // No account connected: scheduling keeps the card and says so.
    const noAccount = await decide({ ...apiDeps(), entitlements: undefined }, owner, second!.id, {
      action: 'keep',
      mode: 'schedule',
    });
    expect(noAccount.publish).toBe('no_accounts');

    // The allowance is exhausted: QuotaExceededError, and the card is still READY.
    await refillBlitzQueue(refillDeps(fakeGenerator()), refillScope());
    const third = await db.blitzSuggestion.findFirstOrThrow({
      where: { ...scope(), status: 'RENDERING' },
    });
    await db.blitzSuggestion.update({ where: { id: third.id }, data: { status: 'READY' } });
    await db.videoProject.update({
      where: { id: third.projectId! },
      data: { state: 'READY_FOR_REVIEW' },
    });
    const entitlements = {
      forOrganisation: async () => ({
        tier: 'STANDARD' as const,
        access: 'full' as const,
        source: 'stripe' as const,
        limits: { seats: 5, businesses: 1, storageGb: 25 },
        custom: { shortVideos: 0 },
      }),
      invalidate: () => undefined,
    };
    await expect(
      decide({ ...apiDeps(), entitlements: entitlements as never }, owner, third.id, {
        action: 'keep',
        mode: 'edit',
      }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
    expect((await db.blitzSuggestion.findUniqueOrThrow({ where: { id: third.id } })).status).toBe(
      'READY',
    );
  });

  it('keeping a paid preview card is what generates it', async () => {
    await putMix(db, scope(), 'user-1', {
      formatWeights: { carousel: 0, slideshow: 0, ai_video: 100 },
    });
    await refillBlitzQueue(refillDeps(fakeGenerator()), refillScope());
    const card = await db.blitzSuggestion.findFirstOrThrow({
      where: { ...scope(), status: 'READY' },
    });
    expect(card.projectId).toBeNull();
    expect(queue.pending.filter((j) => j.name === 'plan-project')).toHaveLength(0);
    const result = await decide(apiDeps(), owner, card.id, { action: 'keep', mode: 'edit' });
    expect(result.projectId).toBeTruthy();
    const project = await db.videoProject.findUniqueOrThrow({ where: { id: result.projectId! } });
    expect(project.sourceType).toBe('BRIEF');
    expect(project.state).toBe('QUEUED');
    expect(queue.pending.filter((j) => j.name === 'plan-project')).toHaveLength(1);
  });

  it('a viewer cannot swipe a card into posting', async () => {
    await refillBlitzQueue(refillDeps(fakeGenerator()), refillScope());
    const card = await db.blitzSuggestion.findFirstOrThrow({
      where: { ...scope(), status: { in: ['READY', 'RENDERING'] } },
    });
    await db.blitzSuggestion.update({ where: { id: card.id }, data: { status: 'READY' } });
    const writer = tenant(org, ['studio:project:read', 'studio:project:write']);
    await expect(
      decide(apiDeps(), writer, card.id, { action: 'keep', mode: 'post_now' }),
    ).rejects.toThrow(/approves and publishes/);
    // Another organisation does not see it.
    await expect(
      decide(apiDeps(), tenant(`other-${randomUUID()}`), card.id, { action: 'skip' }),
    ).rejects.toThrow(/not found/);
  });
});
