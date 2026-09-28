// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProjectDetail } from '@/lib/client/types';
import { FallbackNote, fallbacksOf } from './paused-notes';

// 15.B9 — the review-screen "we used a fallback provider" note.

const project = (metadata: Record<string, unknown> | null) =>
  ({ id: 'p', state: 'READY_FOR_REVIEW', errorReason: null, metadata }) as unknown as ProjectDetail;

describe('FallbackNote', () => {
  it('explains which layer used a fallback and why', () => {
    render(
      <FallbackNote
        project={project({
          fallbacks: [
            {
              layer: 'visual',
              shotId: 's1',
              usedProviderId: 'luma',
              skipped: [{ providerId: 'runway', reason: 'circuit_open' }],
            },
          ],
        })}
      />,
    );
    const note = screen.getByRole('region', { name: 'Fallback provider used' });
    expect(note).toHaveTextContent('fallback provider for the visuals');
    expect(note).toHaveTextContent('made with luma (runway temporarily unavailable)');
  });

  it('renders nothing without fallbacks and ignores malformed entries', () => {
    const { container } = render(<FallbackNote project={project({ fallbacks: [] })} />);
    expect(container).toBeEmptyDOMElement();
    expect(fallbacksOf({ fallbacks: [{ layer: 1 }, 'x'] })).toEqual([]);
    expect(fallbacksOf(null)).toEqual([]);
  });
});
