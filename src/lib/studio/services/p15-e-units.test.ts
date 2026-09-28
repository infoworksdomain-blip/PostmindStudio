import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { NotImplementedError } from '../../errors';
import { IDEOGRAM_PENDING_MESSAGE, IdeogramAdapter } from '../providers/ideogram';
import { createProviderRegistry } from '../providers/registry';
import { routeProvider, planCandidates } from '../providers/router';
import { StubAdapter } from '../providers/test-adapter';
import { createCircuitBreaker } from '../providers/circuit-breaker';
import type { CalendarShadowClient } from '../core/calendar-shadow-client';
import type { UsageReporter } from '../core/usage-reporter';
import { syncCalendarShadows } from './calendar-shadows';
import { contentBrief } from './content-projects';
import { monthsBefore, retentionCutoffs } from './retention';
import { hashShareToken, hasControlCharacters, newShareToken } from './share-links';
import { flushUsageEvents } from './usage-events';

// Phase 15 track E unit tests that need no database.

const logger = pino({ level: 'silent' });

describe('share-link tokens (15.E5)', () => {
  it('are 43-char base64url, unique, and stored only as SHA-256 hex', () => {
    const a = newShareToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newShareToken()).not.toBe(a);
    expect(hashShareToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashShareToken(a)).not.toContain(a);
  });

  it('flags control characters but allows newlines, RTL and CJK text', () => {
    expect(hasControlCharacters('bad\u0007')).toBe(true);
    expect(hasControlCharacters('line\nline\ttab')).toBe(false);
    expect(hasControlCharacters('رائع جدا 很好 बहुत अच्छा')).toBe(false);
  });
});

describe('retention cutoffs (15.E8)', () => {
  const now = Date.UTC(2026, 9, 1, 12);
  it('follow the spec 7.15 table', () => {
    const cut = retentionCutoffs(now);
    const days = (d: Date) => Math.round((now - d.getTime()) / 86_400_000);
    expect(days(cut.provider_jobs)).toBe(60);
    expect(days(cut.video_assets)).toBe(30);
    expect(days(cut.video_renders)).toBe(90);
    expect(cut.provider_usage.toISOString()).toBe('2025-10-01T12:00:00.000Z');
    expect(cut.approval_tasks.toISOString()).toBe('2025-10-01T12:00:00.000Z');
  });
  it('monthsBefore crosses years', () => {
    expect(monthsBefore(Date.UTC(2026, 1, 15), 3).toISOString()).toBe('2025-11-15T00:00:00.000Z');
  });
});

describe('contentBrief (15.W1)', () => {
  it('joins title, text and product facts, capped at 4000 chars', () => {
    expect(
      contentBrief({
        id: 'c',
        organisationId: 'o',
        businessId: null,
        kind: 'product',
        title: 'Loaf',
        text: 'Fresh daily',
        media: [],
        product: { name: 'Sourdough', price: '£4.50' },
      }),
    ).toBe('Loaf\n\nFresh daily\n\nProduct: Sourdough (£4.50)');
    expect(
      contentBrief({
        id: 'c',
        organisationId: 'o',
        businessId: null,
        kind: 'post',
        title: null,
        text: 'y'.repeat(5000),
        media: [],
        product: null,
      }),
    ).toHaveLength(4000);
  });
});

describe('Ideogram slot (15.W6)', () => {
  it('the adapter is an honest 501 and reports unhealthy', async () => {
    const a = new IdeogramAdapter();
    await expect(a.submit()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(a.poll()).rejects.toThrow(IDEOGRAM_PENDING_MESSAGE);
    await expect(a.cancel()).rejects.toBeInstanceOf(NotImplementedError);
    expect(await a.healthCheck()).toMatchObject({ healthy: false });
  });

  it('is listed last for IMAGE_STILL but never selected without a registered adapter', async () => {
    const need = { kind: 'shot' as const, visualTreatment: 'IMAGE_STILL' as const, durationSec: 3 };
    expect(planCandidates(need, 'STANDARD').providerIds.at(-1)).toBe('ideogram');
    const deps = {
      registry: createProviderRegistry([new StubAdapter('openai', ['text_to_image'])]),
      breaker: createCircuitBreaker(() => 0),
      killSwitch: { check: vi.fn(async () => ({ killed: false as const })) },
      budget: { hasBudget: async () => true },
      now: () => 0,
    };
    const input = {
      need,
      planTier: 'STANDARD' as const,
      organisationId: 'o',
      request: {
        capability: 'text_to_image' as const,
        organisationId: 'o',
        prompt: 'bread',
        aspectRatio: '9:16' as const,
      },
    };
    expect((await routeProvider(input as never, deps as never)).providerId).toBe('openai');
    for (let i = 0; i < 5; i += 1) await deps.breaker.recordFailure('openai');
    // openai down, fal and ideogram unregistered → no provider, never Ideogram.
    await expect(routeProvider(input as never, deps as never)).rejects.toThrow(/No provider/);
  });
});

describe('usage + calendar flush with a pending client (15.W2 / 15.W3)', () => {
  it('usage events stay pending_setup and nothing is sent', async () => {
    const db = { usageEvent: { count: vi.fn(async () => 4), findMany: vi.fn() } };
    const reporter: UsageReporter = { ready: false, send: vi.fn() };
    const out = await flushUsageEvents({ db: db as never, logger, now: () => 0 }, reporter);
    expect(out).toEqual({ status: 'pending_setup', pending: 4, sent: 0, failed: 0 });
    expect(reporter.send).not.toHaveBeenCalled();
  });

  it('a ready reporter sends payloads and marks rows sent; a failure marks them failed', async () => {
    const rows = [
      {
        id: 'u1',
        organisationId: 'o',
        eventType: 'provider_cost_incurred',
        eventKey: 'provider_job:j1',
        occurredAt: new Date(0),
        payload: { costPence: 42 },
      },
    ];
    const db = { usageEvent: { findMany: vi.fn(async () => rows), updateMany: vi.fn() } };
    const send = vi.fn(async () => ({ accepted: 1 }));
    const out = await flushUsageEvents(
      { db: db as never, logger, now: () => 0 },
      { ready: true, send },
    );
    expect(out.sent).toBe(1);
    expect(send).toHaveBeenCalledWith([
      expect.objectContaining({
        idempotencyKey: 'provider_job:j1',
        costPence: 42,
        currency: 'GBP',
      }),
    ]);
    const failing = await flushUsageEvents(
      { db: db as never, logger, now: () => 0 },
      { ready: true, send: vi.fn(async () => Promise.reject(new Error('503'))) },
    );
    expect(failing.failed).toBe(1);
    expect(db.usageEvent.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'failed' }) }),
    );
  });

  it('calendar shadows stay pending_setup; a ready client upserts and removes', async () => {
    const pending: CalendarShadowClient = { ready: false, upsert: vi.fn(), remove: vi.fn() };
    const count = vi.fn(async () => 2);
    expect(
      await syncCalendarShadows(
        { db: { calendarShadow: { count } } as never, logger, now: () => 0 },
        pending,
        'https://studio.test',
      ),
    ).toMatchObject({ status: 'pending_setup', pending: 2 });
    const rows = [
      {
        publicationId: 'p1',
        organisationId: 'o',
        projectId: 'prj',
        platform: 'tiktok',
        desiredOp: 'upsert',
        scheduledFor: new Date(0),
        title: 'T',
        coreEntryId: null,
      },
      { publicationId: 'p2', organisationId: 'o', desiredOp: 'delete', coreEntryId: 'c2' },
    ];
    const update = vi.fn();
    const ready: CalendarShadowClient = {
      ready: true,
      upsert: vi.fn(async () => ({ coreEntryId: 'c1' })),
      remove: vi.fn(async () => undefined),
    };
    const out = await syncCalendarShadows(
      {
        db: { calendarShadow: { findMany: async () => rows, update } } as never,
        logger,
        now: () => 0,
      },
      ready,
      'https://studio.test/',
    );
    expect(out).toMatchObject({ status: 'synced', synced: 2, failed: 0 });
    expect(ready.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ link: 'https://studio.test/projects/prj' }),
    );
    expect(ready.remove).toHaveBeenCalledWith({ publicationId: 'p2', organisationId: 'o' });
  });
});
