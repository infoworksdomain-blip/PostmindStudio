import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { ALL_MESSAGES } from '../../i18n/all-messages';
import { LOCALES } from '../../i18n/locales';
import { alertMessage, type CapUsage } from '../cost/guard';
import { quotaMessage } from '../services/plan-quotas';
import type { NotificationMessage } from './notifier';

// BACKLOG 16.5 — the cost, safety-review and plan-quota notifications carry a message key + ICU
// params, and every key renders in every locale without leaving a placeholder behind.

const usage = (over: Partial<CapUsage>): CapUsage => ({
  scope: 'ORG_DAILY',
  scopeId: 'o',
  organisationId: 'o',
  period: '2026-09-28',
  capPence: 5_000,
  spentPence: 4_000,
  thresholds: [80, 100],
  ...over,
});

const project = { id: 'p', name: 'Spring menu', createdByUserId: 'u' };

describe('alertMessage message keys', () => {
  it.each([
    [usage({ scope: 'PROJECT', project }), 50, 'costProjectAlert'],
    [usage({ scope: 'PROJECT', project }), 90, 'costProjectPaused'],
    [usage({ scope: 'PROJECT', project }), 100, 'costProjectOverBudget'],
    [usage({}), 80, 'costDailyAlert'],
    [usage({ spentPence: 5_000 }), 100, 'costDailyPaused'],
    [usage({ scope: 'ORG_MONTHLY' }), 80, 'costMonthlyAlert'],
    [usage({ scope: 'ORG_MONTHLY', spentPence: 5_000 }), 100, 'costMonthlyPaused'],
    [usage({ scope: 'ORG_PROVIDER_DAILY', provider: 'runway' }), 100, 'costProviderDaily'],
    [usage({ scope: 'GLOBAL_DAILY', organisationId: null }), 80, 'costGlobalAlert'],
    [usage({ scope: 'GLOBAL_DAILY', organisationId: null }), 100, 'costGlobalPaused'],
  ] as const)('%#: %s at %s% → %s', (u, threshold, key) => {
    expect(alertMessage(u, threshold).message?.key).toBe(key);
  });

  it('passes money in pounds and the thresholds as numbers', () => {
    expect(alertMessage(usage({ scope: 'PROJECT', project }), 50).message?.params).toEqual({
      spent: 40,
      cap: 50,
      threshold: 50,
      name: 'Spring menu',
      pausePercent: 90,
    });
  });

  it('keeps the stored English text when there is nothing to name', () => {
    expect(alertMessage(usage({ scope: 'PROJECT' }), 50).message).toBeUndefined();
    expect(alertMessage(usage({ scope: 'ORG_PROVIDER_DAILY' }), 80).message).toBeUndefined();
  });
});

describe('quotaMessage', () => {
  it('picks nearing / reached / blocked and names the next tier', () => {
    expect(quotaMessage('BASIC', 'short', 80, { used: 8, limit: 10 }, false)).toEqual({
      key: 'planQuotaNearing',
      params: {
        tier: 'Basic',
        kind: 'short',
        threshold: 80,
        used: 8,
        limit: 10,
        nextTier: 'Standard',
      },
    });
    expect(quotaMessage('BASIC', 'long', 100, { used: 2, limit: 2 }, false).key).toBe(
      'planQuotaReached',
    );
    expect(quotaMessage('BASIC', 'long', 100, { used: 2, limit: 2 }, true).key).toBe(
      'planQuotaBlocked',
    );
  });
});

const SAMPLES: NotificationMessage[] = [
  alertMessage(usage({ scope: 'PROJECT', project }), 50).message!,
  alertMessage(usage({ scope: 'PROJECT', project }), 90).message!,
  alertMessage(usage({ scope: 'PROJECT', project }), 100).message!,
  alertMessage(usage({}), 80).message!,
  alertMessage(usage({}), 100).message!,
  alertMessage(usage({ scope: 'ORG_MONTHLY' }), 80).message!,
  alertMessage(usage({ scope: 'ORG_MONTHLY' }), 100).message!,
  alertMessage(usage({ scope: 'ORG_PROVIDER_DAILY', provider: 'runway' }), 80).message!,
  alertMessage(usage({ scope: 'GLOBAL_DAILY' }), 80).message!,
  alertMessage(usage({ scope: 'GLOBAL_DAILY' }), 100).message!,
  { key: 'safetyReviewStaff', params: { name: 'Spring menu', kind: 'script', reason: 'r' } },
  { key: 'safetyReviewOpened', params: { name: 'Spring menu' } },
  { key: 'safetyReviewAllowed', params: { name: 'Spring menu' } },
  { key: 'safetyReviewBlocked', params: { name: 'Spring menu', note: 'n' } },
  {
    key: 'safetyAuditMiss',
    params: {
      platform: 'tiktok',
      organisationId: 'o',
      publicationId: 'pub',
      period: '2026-09',
      note: 'n',
    },
  },
  quotaMessage('BASIC', 'short', 80, { used: 8, limit: 10 }, false),
  quotaMessage('ENTERPRISE', 'long', 100, { used: 2, limit: 2 }, false),
  quotaMessage('BASIC', 'long', 100, { used: 2, limit: 2 }, true),
];

describe('keyed notifications render in every locale', () => {
  it.each(LOCALES)('%s', (locale) => {
    const t = createTranslator({
      locale,
      messages: ALL_MESSAGES[locale],
      namespace: 'notifications',
    });
    for (const m of SAMPLES) {
      for (const part of ['title', 'body'] as const) {
        const text = t(`${m.key}.${part}`, m.params ?? {});
        expect(text, `${locale} ${m.key}.${part}`).not.toMatch(/[{}]/);
        expect(text.length).toBeGreaterThan(3);
      }
    }
  });

  it('formats money as GBP and drops the upgrade hint on the top tier', () => {
    const t = createTranslator({
      locale: 'en-GB',
      messages: ALL_MESSAGES['en-GB'],
      namespace: 'notifications',
    });
    expect(t('costDailyAlert.body', { spent: 40, cap: 50, threshold: 80 })).toMatch(
      /^£40\.00 of £50\.00/,
    );
    const top = quotaMessage('ENTERPRISE', 'long', 100, { used: 2, limit: 2 }, false);
    expect(t('planQuotaReached.body', top.params ?? {})).not.toContain('Upgrade');
  });
});
