// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { staleRenderIds } from './review-screen';
import { makeProject, makeRender, mockFetch, renderWithSWR } from './test-helpers';
import { VariantCard } from './variant-card';

// 13.1 / 13.2 — variants rendered before a script or shot edit say so and offer a re-render.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

describe('stale variants', () => {
  it('reads metadata.staleRenders', () => {
    expect([...staleRenderIds(makeProject({ metadata: { staleRenders: ['ren_1', 3] } }))]).toEqual([
      'ren_1',
    ]);
    expect(staleRenderIds(makeProject({ metadata: null })).size).toBe(0);
  });

  it('marks an out-of-date variant and re-renders it', async () => {
    const onChanged = vi.fn();
    const api = mockFetch([
      { match: '/renders/ren_1/preview', body: { ok: true, url: 'https://x.test/v.mp4' } },
      {
        method: 'POST',
        match: '/renders/ren_1/rerender',
        status: 202,
        body: { ok: true, projectId: 'proj_1', runId: 'r' },
      },
    ]);
    renderWithSWR(
      <VariantCard
        render={makeRender()}
        stale
        projectState="READY_FOR_REVIEW"
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText('Out of date')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Re-render/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.find('POST', '/renders/ren_1/rerender')).toHaveLength(1);
  });

  it('shows nothing extra for a current variant', () => {
    mockFetch([
      { match: '/renders/ren_1/preview', body: { ok: true, url: 'https://x.test/v.mp4' } },
    ]);
    renderWithSWR(<VariantCard render={makeRender()} onChanged={vi.fn()} />);
    expect(screen.queryByText('Out of date')).not.toBeInTheDocument();
  });
});
