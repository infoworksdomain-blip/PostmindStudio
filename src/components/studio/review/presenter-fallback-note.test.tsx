// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProjectDetail } from '@/lib/client/types';
import { degradedPresenterShots, PresenterFallbackNote } from './paused-notes';

// 20.19 — the review-screen note when an avatar presenter shot became a generated clip.

const project = (metadata: Record<string, unknown> | null) =>
  ({ id: 'p', state: 'READY_FOR_REVIEW', errorReason: null, metadata }) as unknown as ProjectDetail;

describe('PresenterFallbackNote', () => {
  it('tells the customer gently, without provider names or reasons', () => {
    render(
      <PresenterFallbackNote
        project={project({
          degradedShots: [
            { shotId: 's3', degradedFrom: 'avatar_video', reason: 'insufficient_credits' },
            { shotId: 's7', degradedFrom: 'avatar_video', reason: 'insufficient_credits' },
          ],
        })}
      />,
    );
    const note = screen.getByRole('note', { name: 'Presenter not available' });
    expect(note).toHaveTextContent(
      'The presenter wasn’t available for this video, so those moments use video clips instead.',
    );
    expect(note).not.toHaveTextContent(/heygen|credit/i);
  });

  it('renders nothing without degraded shots and ignores malformed entries', () => {
    const { container } = render(<PresenterFallbackNote project={project({})} />);
    expect(container).toBeEmptyDOMElement();
    expect(
      degradedPresenterShots({
        degradedShots: [{ shotId: 1 }, 'x', { shotId: 's', degradedFrom: 'other' }],
      }),
    ).toEqual([]);
    expect(degradedPresenterShots(null)).toEqual([]);
  });
});
