import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { milestoneKey, MILESTONES, notifyMilestones, reachedMilestones } from './milestones';
import type { Notifier } from './notifier';

// BACKLOG 13.23 / spec 14.4 — milestone notifications (10k views, 100 comments), once per
// publication per threshold (the notification dedupe key is the guarantee).

const publication = {
  id: 'pub-1',
  organisationId: 'org-1',
  projectId: 'prj-1',
  platform: 'tiktok',
};

function host(
  project: { name: string; createdByUserId: string } | null = {
    name: 'Spring menu',
    createdByUserId: 'user-1',
  },
) {
  const notify = vi.fn(async () => ({ created: true }));
  const notifier: Notifier = { notify, notifyStaff: vi.fn(async () => 0) };
  return {
    notify,
    host: {
      db: { videoProject: { findFirst: vi.fn(async () => project) } } as never,
      logger: pino({ level: 'silent' }),
      notifier,
    },
  };
}

describe('reachedMilestones', () => {
  it('matches at or above each threshold only', () => {
    expect(reachedMilestones({ views: 9_999, comments: 99 })).toEqual([]);
    expect(reachedMilestones({ views: 10_000, comments: 99 })).toEqual([MILESTONES[0]]);
    expect(reachedMilestones({ views: 25_000, comments: 140 })).toEqual(MILESTONES);
  });
});

describe('notifyMilestones', () => {
  it('notifies the creator once per milestone with a stable dedupe key', async () => {
    const { host: h, notify } = host();
    expect(await notifyMilestones(h, publication, { views: 12_345, comments: 100 })).toBe(2);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        organisationId: 'org-1',
        userId: 'user-1',
        kind: 'milestone',
        title: '“Spring menu” reached 10,000 views on TikTok',
        link: '/projects/prj-1',
        dedupeKey: 'milestone:pub-1:views_10000',
        // 16.5: rendered in the reader's locale from notifications.milestoneViews.
        message: {
          key: 'milestoneViews',
          params: { name: 'Spring menu', platform: 'tiktok', threshold: 10_000, count: 12_345 },
        },
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: milestoneKey('pub-1', MILESTONES[1]!) }),
    );
  });

  it('does not look anything up below the thresholds', async () => {
    const { host: h, notify } = host();
    expect(await notifyMilestones(h, publication, { views: 10, comments: 1 })).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    expect(
      (h.db as unknown as { videoProject: { findFirst: ReturnType<typeof vi.fn> } }).videoProject
        .findFirst,
    ).not.toHaveBeenCalled();
  });

  it('never throws into the poller', async () => {
    const h = {
      db: {
        videoProject: { findFirst: vi.fn(async () => Promise.reject(new Error('db down'))) },
      } as never,
      logger: pino({ level: 'silent' }),
    };
    await expect(notifyMilestones(h, publication, { views: 20_000, comments: 0 })).resolves.toBe(0);
    const { host: missing, notify } = host(null);
    expect(await notifyMilestones(missing, publication, { views: 20_000, comments: 0 })).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });
});
