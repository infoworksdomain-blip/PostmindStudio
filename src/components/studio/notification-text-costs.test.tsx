// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from './review/test-helpers';
import { plainCostKey, useNotificationText } from './notification-text';

// Operator decision 2026-10-04: customers never see generation cost. Cost notifications read as a
// plain limit sentence for them; platform staff keep the keyed text with amounts.
// The customer cases need notifications.costPlain.* from .i18n-tmp/frag-costs/en-GB.json.

afterEach(() => vi.unstubAllGlobals());

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

function meAs(platformRole: string) {
  return mockFetch([
    { match: '/me', body: { ok: true, me: { capabilities: [], user: { platformRole } } } },
  ]);
}

const projectPaused = {
  kind: 'cost_paused',
  title: 'Generation paused: “Launch” reached 90% of its budget',
  body: '£9.00 of £10.00 spent.',
  messageKey: 'costProjectPaused',
  messageParams: { name: 'Launch', pausePercent: 90, spent: 9, cap: 10 },
};

describe('plainCostKey', () => {
  it('maps every customer cost key, and other cost rows to the generic line', () => {
    expect(plainCostKey(projectPaused)).toBe('projectPaused');
    expect(plainCostKey({ ...projectPaused, messageKey: 'costProjectOverBudget' })).toBe(
      'projectPaused',
    );
    expect(plainCostKey({ ...projectPaused, messageKey: 'costMonthlyAlert' })).toBe('monthlyAlert');
    expect(plainCostKey({ kind: 'cost_alert', title: 'x', body: 'y' })).toBe('generic');
    expect(plainCostKey({ ...projectPaused, messageKey: 'costGlobalAlert' })).toBe('generic');
    expect(
      plainCostKey({
        kind: 'generation_ready',
        title: 'x',
        body: 'y',
        messageKey: 'generationReady',
      }),
    ).toBeNull();
  });
});

describe('useNotificationText cost notifications', () => {
  it('shows staff the amounts', async () => {
    meAs('staff');
    const { result } = renderHook(() => useNotificationText(), { wrapper });
    await waitFor(() => expect(result.current(projectPaused).body).toMatch(/£9\.00 of £10\.00/));
  });

  it('shows customers a limit sentence without amounts, percentages or budget wording', async () => {
    const api = meAs('user');
    const { result } = renderHook(() => useNotificationText(), { wrapper });
    await waitFor(() => expect(api.find('GET', '/me')).toHaveLength(1));
    for (const messageKey of [
      'costProjectAlert',
      'costProjectPaused',
      'costProjectOverBudget',
      'costDailyAlert',
      'costDailyPaused',
      'costMonthlyAlert',
      'costMonthlyPaused',
      null,
    ]) {
      const text = result.current({ ...projectPaused, messageKey });
      expect(`${text.title} ${text.body}`).not.toMatch(/£|\d+ ?%|budget|spen[dt]|cost/i);
      expect(text.title.length).toBeGreaterThan(0);
    }
    expect(result.current(projectPaused).title).toContain('Launch');
  });
});
