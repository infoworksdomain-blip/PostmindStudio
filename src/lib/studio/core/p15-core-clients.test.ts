import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { NotImplementedError } from '../../errors';
import { CALENDAR_PENDING_MESSAGE, pendingCalendarShadowClient } from './calendar-shadow-client';
import { CONTENT_PENDING_MESSAGE, pendingCoreContentClient } from './content-client';
import { loadTriggerFields, triggerFieldsEnabled, withTriggerFields } from './engagement-trigger';
import {
  ORGANISATION_LIST_PENDING_MESSAGE,
  pendingCoreOrganisationDirectory,
} from './organisation-directory';
import { pendingUsageReporter, USAGE_PENDING_MESSAGE } from './usage-reporter';

// 15.W1–W5: the Core / Engagement contracts are honest 501s until the other side ships.

describe('pending Core clients (15.W1–W4)', () => {
  it('content client is not ready and throws NotImplementedError naming the Core endpoint', async () => {
    expect(pendingCoreContentClient.ready).toBe(false);
    const call = pendingCoreContentClient.getContent({ organisationId: 'o', contentId: 'c' });
    await expect(call).rejects.toBeInstanceOf(NotImplementedError);
    await expect(call).rejects.toThrow(CONTENT_PENDING_MESSAGE);
    expect(CONTENT_PENDING_MESSAGE).toContain('/api/internal/content/:id');
  });

  it('usage reporter, calendar client and organisation directory are pending', async () => {
    expect(pendingUsageReporter.ready).toBe(false);
    await expect(pendingUsageReporter.send([])).rejects.toThrow(USAGE_PENDING_MESSAGE);
    expect(pendingCalendarShadowClient.ready).toBe(false);
    await expect(
      pendingCalendarShadowClient.remove({ publicationId: 'p', organisationId: 'o' }),
    ).rejects.toThrow(CALENDAR_PENDING_MESSAGE);
    await expect(
      pendingCalendarShadowClient.upsert({
        publicationId: 'p',
        organisationId: 'o',
        projectId: 'x',
        platform: 'tiktok',
        scheduledFor: '2026-10-01T00:00:00Z',
        title: null,
        link: 'l',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    expect(pendingCoreOrganisationDirectory.ready).toBe(false);
    await expect(pendingCoreOrganisationDirectory.existing(['o'])).rejects.toThrow(
      ORGANISATION_LIST_PENDING_MESSAGE,
    );
  });
});

describe('Engagement trigger fields (15.W5)', () => {
  const pub = {
    hashtags: ['#launch', 'bakery'],
    publishedAt: new Date('2026-10-01T09:00:00Z'),
    project: {
      id: 'prj_1',
      businessId: 'biz_1',
      sourceType: 'BRIEF',
      templateId: null,
      metadata: { tags: ['spring', 3] },
    },
  };
  const db = (row: unknown) => ({ videoPublication: { findFirst: vi.fn(async () => row) } });
  const body = {
    publicationId: 'pub_1',
    organisationId: 'org',
    platform: 'tiktok',
    platformPostId: 'x',
  };

  it('is off unless STUDIO_ENGAGEMENT_TRIGGER_FIELDS=true', () => {
    expect(triggerFieldsEnabled({})).toBe(false);
    expect(triggerFieldsEnabled({ STUDIO_ENGAGEMENT_TRIGGER_FIELDS: 'TRUE' })).toBe(true);
  });

  it('loads hashtags without # and string project tags', async () => {
    expect(await loadTriggerFields(db(pub) as never, 'pub_1', 'org')).toEqual({
      hashtags: ['launch', 'bakery'],
      projectId: 'prj_1',
      projectTags: ['spring'],
      businessId: 'biz_1',
      sourceType: 'BRIEF',
      templateId: null,
      publishedAt: '2026-10-01T09:00:00.000Z',
    });
    expect(await loadTriggerFields(db(null) as never, 'pub_1', 'org')).toBeNull();
  });

  it('flag off leaves the client untouched; on adds trigger; a lookup failure still attributes', async () => {
    const inner = { attributePublication: vi.fn(async () => undefined) };
    const logger = pino({ level: 'silent' });
    expect(withTriggerFields(inner, { db: db(pub) as never, logger, enabled: false })).toBe(inner);
    await withTriggerFields(inner, {
      db: db(pub) as never,
      logger,
      enabled: true,
    }).attributePublication(body);
    expect(inner.attributePublication).toHaveBeenLastCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({ hashtags: ['launch', 'bakery'] }),
      }),
    );
    const broken = {
      videoPublication: { findFirst: vi.fn(async () => Promise.reject(new Error('db'))) },
    };
    await withTriggerFields(inner, {
      db: broken as never,
      logger,
      enabled: true,
    }).attributePublication(body);
    expect(inner.attributePublication).toHaveBeenLastCalledWith(body);
  });
});
