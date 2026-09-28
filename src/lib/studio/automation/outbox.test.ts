import type { AutoPublishOutbox } from '@prisma/client';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError, PayloadTooLargeError, ValidationError } from '../../errors';
import {
  coveringPublicationId,
  dispatchOutbox,
  isRetryableSendError,
  MAX_OUTBOX_ATTEMPTS,
  outboxBackoffMs,
  publicOutboxRow,
  renderIdFor,
  type SendOutcome,
} from './outbox';

// BACKLOG 13.21 — auto-publish outbox rules (the database path, claim and approval transaction
// are covered by test/api/auto-publish-outbox.test.ts and test/golden/admin-automation.test.ts).

const NOW = Date.parse('2026-09-29T12:00:00Z');

function row(over: Partial<AutoPublishOutbox> = {}): AutoPublishOutbox {
  return {
    id: 'apo-1',
    organisationId: 'org-1',
    projectId: 'prj-1',
    approvalTaskId: 'apr-1',
    targetIndex: 0,
    target: { platform: 'tiktok', connectionId: 'conn-1' },
    planTier: 'STANDARD',
    trigger: 'human',
    state: 'PENDING',
    attempts: 0,
    nextAttemptAt: new Date(NOW),
    lockedAt: null,
    lastError: null,
    publicationId: null,
    scheduledFor: null,
    slotAt: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...over,
  };
}

describe('outboxBackoffMs', () => {
  it('backs off 1 min, 5 min, 25 min, then caps at 2 h', () => {
    expect([1, 2, 3, 4, 5].map(outboxBackoffMs)).toEqual([
      60_000, 300_000, 1_500_000, 7_200_000, 7_200_000,
    ]);
  });
});

describe('error classification', () => {
  it('retries conflicts, server errors and unexpected errors; not bad requests', () => {
    expect(isRetryableSendError(new ConflictError('needs reconnecting'))).toBe(true);
    expect(isRetryableSendError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableSendError(new ValidationError('bad caption'))).toBe(false);
    expect(isRetryableSendError(new NotFoundError('render gone'))).toBe(false);
    expect(isRetryableSendError(new PayloadTooLargeError('too big'))).toBe(true);
  });

  it('reads the covering publication from a duplicate conflict', () => {
    expect(
      coveringPublicationId(new ConflictError('already scheduled', { publicationId: 'pub-9' })),
    ).toBe('pub-9');
    expect(coveringPublicationId(new ConflictError('other'))).toBeUndefined();
    expect(coveringPublicationId(new Error('x'))).toBeUndefined();
  });
});

describe('publicOutboxRow / renderIdFor', () => {
  it('exposes the target account but not caption internals', () => {
    expect(
      publicOutboxRow(row({ state: 'FAILED', attempts: 5, lastError: 'needs reconnecting' })),
    ).toMatchObject({
      target: { platform: 'tiktok', account: 'conn-1', scheduleOffsetMinutes: null },
      state: 'FAILED',
      attempts: 5,
      maxAttempts: MAX_OUTBOX_ATTEMPTS,
      nextAttemptAt: null,
    });
  });

  it('only picks a render of the current run for the platform', () => {
    const renders = [
      { id: 'old', targetPlatform: 'tiktok' },
      { id: 'new', targetPlatform: 'tiktok' },
      { id: 'yt', targetPlatform: 'youtube_short' },
    ];
    const metadata = { renders: { s1: 'new', s2: 'yt' } };
    expect(renderIdFor(metadata, renders, 'tiktok')).toBe('new');
    expect(renderIdFor(metadata, renders, 'x')).toBeUndefined();
  });
});

function fakeDb(rows: AutoPublishOutbox[]) {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  return {
    rows: byId,
    db: {
      autoPublishOutbox: {
        findMany: vi.fn(async () => [...byId.values()].map((r) => ({ ...r }))),
        updateMany: vi.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const current = byId.get(where.id);
            if (!current || (current.state !== 'PENDING' && current.state !== 'SENDING'))
              return { count: 0 };
            byId.set(where.id, {
              ...current,
              state: 'SENDING',
              lockedAt: data.lockedAt as Date,
              attempts: current.attempts + 1,
            });
            return { count: 1 };
          },
        ),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: Partial<AutoPublishOutbox> }) => {
            const next = { ...(byId.get(where.id) as AutoPublishOutbox), ...data };
            byId.set(where.id, next);
            return next;
          },
        ),
      },
      videoProject: {
        findUnique: vi.fn(async () => ({ name: 'Spring menu', createdByUserId: 'user-1' })),
      },
      notification: {
        createManyAndReturn: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) =>
          data.map((d, i) => ({ id: `n${i}`, createdAt: new Date(NOW), ...d })),
        ),
      },
    },
  };
}

describe('dispatchOutbox', () => {
  const logger = pino({ level: 'silent' });

  it('marks sent rows SENT, schedules a retry for retryable failures, gives up after the last', async () => {
    const { db, rows } = fakeDb([
      row({ id: 'ok' }),
      row({ id: 'retry', targetIndex: 1 }),
      row({ id: 'last', targetIndex: 2, attempts: MAX_OUTBOX_ATTEMPTS - 1 }),
      row({ id: 'bad', targetIndex: 3 }),
    ]);
    const notify = vi.fn(async () => ({ created: true }));
    const send = vi.fn(async (r: AutoPublishOutbox): Promise<SendOutcome> => {
      if (r.id === 'ok') return { status: 'sent', publicationId: 'pub-1' };
      if (r.id === 'bad') return { status: 'failed', error: 'invalid caption', retryable: false };
      return { status: 'failed', error: 'needs reconnecting', retryable: true };
    });
    await dispatchOutbox(
      {
        db: db as never,
        logger,
        now: () => NOW,
        notifier: { notify, notifyStaff: vi.fn() },
      } as never,
      send,
    );
    expect(rows.get('ok')).toMatchObject({ state: 'SENT', publicationId: 'pub-1', attempts: 1 });
    expect(rows.get('retry')).toMatchObject({
      state: 'PENDING',
      attempts: 1,
      lastError: 'needs reconnecting',
    });
    expect(rows.get('retry')?.nextAttemptAt.getTime()).toBe(NOW + 60_000);
    expect(rows.get('last')).toMatchObject({ state: 'FAILED', attempts: MAX_OUTBOX_ATTEMPTS });
    expect(rows.get('bad')).toMatchObject({ state: 'FAILED', attempts: 1 });
    // Creator notified for each target given up on.
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'auto_publish_failed', userId: 'user-1' }),
    );
  });

  it('treats a sender that throws as a retryable failure', async () => {
    const { db, rows } = fakeDb([row()]);
    await dispatchOutbox({ db: db as never, logger, now: () => NOW }, async () => {
      throw new Error('boom');
    });
    expect(rows.get('apo-1')).toMatchObject({ state: 'PENDING', attempts: 1 });
  });

  it('skips a row another sender already claimed', async () => {
    const { db } = fakeDb([row({ state: 'SENT' })]);
    const send = vi.fn();
    await dispatchOutbox({ db: db as never, logger, now: () => NOW }, send);
    expect(send).not.toHaveBeenCalled();
  });
});
