// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR } from '../library/test-helpers';
import { minTierForFeature, PlanLockBadge } from './plan-lock-badge';

function usage(planTier: string) {
  return { match: '/usage', body: { ok: true, usage: { planTier } } };
}

afterEach(() => vi.unstubAllGlobals());

describe('PlanLockBadge', () => {
  it('takes minimum tiers from the plan catalogue', () => {
    expect(minTierForFeature('voiceClone')).toBe('PLUS');
    expect(minTierForFeature('renders4k')).toBe('PLUS');
    expect(minTierForFeature('libraryTemplate')).toBe('PLUS');
    expect(minTierForFeature('imageGeneration')).toBe('PLUS');
    expect(minTierForFeature('customPresets')).toBe('STANDARD');
    expect(minTierForFeature('byocProviderKeys')).toBe('ENTERPRISE');
  });

  it('says "Not in your plan" (21.5: never a tier name) when the plan is below the feature', async () => {
    mockFetch([usage('STANDARD')]);
    renderWithSWR(<PlanLockBadge feature="voiceClone" />);
    expect(await screen.findByText('Not included in your plan')).toHaveClass('sr-only');
    expect(screen.getByText('Not in your plan')).toHaveAttribute('aria-hidden');
    expect(screen.queryByText(/Plus/)).toBeNull();
  });

  it('renders nothing when the plan already includes the feature', async () => {
    const api = mockFetch([usage('PLUS')]);
    const { container } = renderWithSWR(<PlanLockBadge feature="voiceClone" />);
    await vi.waitFor(() => expect(api.fn).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('accepts an explicit required tier', async () => {
    mockFetch([usage('PLUS')]);
    renderWithSWR(<PlanLockBadge requiredTier="ENTERPRISE" />);
    expect(await screen.findByText('Not included in your plan')).toBeInTheDocument();
  });

  it('renders nothing while the tier is unknown', () => {
    mockFetch([]);
    const { container } = renderWithSWR(<PlanLockBadge feature="customPresets" />);
    expect(container).toBeEmptyDOMElement();
  });
});
