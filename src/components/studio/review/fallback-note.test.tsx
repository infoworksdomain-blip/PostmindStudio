// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDetail } from '@/lib/client/types';
import { FallbackNote, fallbacksOf } from './paused-notes';
import { mockFetch, renderWithSWR, type MockRoute } from './test-helpers';

// 15.B9 — the review-screen "we used a fallback provider" note. Which providers were passed over
// and why ("over budget") is for platform staff only (operator decision 2026-10-04).

afterEach(() => vi.unstubAllGlobals());

const project = (metadata: Record<string, unknown> | null) =>
  ({ id: 'p', state: 'READY_FOR_REVIEW', errorReason: null, metadata }) as unknown as ProjectDetail;

const meAs = (platformRole: string): MockRoute => ({
  match: '/me',
  body: { ok: true, me: { capabilities: [], user: { platformRole } } },
});

const withFallback = project({
  fallbacks: [
    {
      layer: 'visual',
      shotId: 's1',
      usedProviderId: 'luma',
      skipped: [{ providerId: 'runway', reason: 'over_budget' }],
    },
  ],
});

describe('FallbackNote', () => {
  it('shows staff which layer used a fallback and why', async () => {
    mockFetch([meAs('staff')]);
    renderWithSWR(<FallbackNote project={withFallback} />);
    const note = screen.getByRole('region', { name: 'Fallback provider used' });
    expect(note).toHaveTextContent('fallback provider for the visuals');
    await waitFor(() => expect(note).toHaveTextContent('made with luma (runway over budget)'));
  });

  it('tells customers about the fallback without providers, reasons or budget wording', async () => {
    const api = mockFetch([meAs('user')]);
    renderWithSWR(<FallbackNote project={withFallback} />);
    const note = screen.getByRole('region', { name: 'Fallback provider used' });
    await waitFor(() => expect(api.find('GET', '/me')).toHaveLength(1));
    expect(note).toHaveTextContent('fallback provider for the visuals');
    expect(note).not.toHaveTextContent(/luma|runway|budget|cost/i);
  });

  it('renders nothing without fallbacks and ignores malformed entries', () => {
    mockFetch([]);
    const { container } = renderWithSWR(<FallbackNote project={project({ fallbacks: [] })} />);
    expect(container).toBeEmptyDOMElement();
    expect(fallbacksOf({ fallbacks: [{ layer: 1 }, 'x'] })).toEqual([]);
    expect(fallbacksOf(null)).toEqual([]);
  });
});
