// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR, summary } from './test-helpers';
import { VideoCard } from './video-card';

afterEach(() => vi.unstubAllGlobals());

describe('VideoCard', () => {
  it('plays the muted preview after hovering for a moment', async () => {
    const { calls } = mockFetch([
      {
        match: '/library/videos/lib_1',
        body: { ok: true, video: { previewUrl: 'https://cdn.test/p.mp4' } },
      },
    ]);
    renderWithSWR(<VideoCard video={summary()} />);
    fireEvent.mouseEnter(screen.getByRole('link', { name: /Morning coffee ritual/ }));
    const preview = await screen.findByTestId('hover-preview');
    expect(preview).toHaveAttribute('src', 'https://cdn.test/p.mp4');
    expect((preview as HTMLVideoElement).muted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('does not fetch a preview for a quick fly-over', async () => {
    const { calls } = mockFetch([]);
    renderWithSWR(<VideoCard video={summary()} />);
    const link = screen.getByRole('link', { name: /Morning coffee ritual/ });
    fireEvent.mouseEnter(link);
    fireEvent.mouseLeave(link);
    await new Promise((r) => setTimeout(r, 450));
    await waitFor(() => expect(calls).toHaveLength(0));
    expect(screen.queryByTestId('hover-preview')).not.toBeInTheDocument();
  });

  it('shows the similarity score when present', () => {
    mockFetch([]);
    renderWithSWR(<VideoCard video={summary({ similarity: 0.734 })} />);
    expect(screen.getByText('73% match')).toBeInTheDocument();
  });
});
