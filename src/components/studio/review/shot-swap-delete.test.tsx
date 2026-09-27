// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShotSwapDelete } from './shot-swap-delete';
import { mockFetch, renderWithSWR } from './test-helpers';

// 13.2 — shot strip "Swap from library" and "Delete shot".

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const images = {
  ok: true,
  data: [{ id: 'img_1', previewUrl: null, altText: 'Loaf', tags: ['bread'] }],
};

describe('ShotSwapDelete', () => {
  it('swaps the shot visual for a library image', async () => {
    const onChanged = vi.fn();
    const api = mockFetch([
      { match: '/image-library', body: images },
      {
        method: 'PATCH',
        match: '/shots/shot_1',
        body: { ok: true, shot: { id: 'shot_1' }, staleRenders: ['ren_1'] },
      },
    ]);
    renderWithSWR(
      <ShotSwapDelete
        shotId="shot_1"
        index={0}
        businessId="biz_1"
        editable
        isLastShot={false}
        onChanged={onChanged}
        onDeleted={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByRole('radio', { name: 'Loaf' }));
    await userEvent.click(screen.getByRole('button', { name: /Use this image/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.find('PATCH', '/shots/shot_1')[0]?.body).toEqual({ imageLibraryId: 'img_1' });
  });

  it('deletes a shot after confirmation, and never the last one', async () => {
    const onDeleted = vi.fn();
    const api = mockFetch([
      {
        method: 'DELETE',
        match: '/shots/shot_1',
        body: { ok: true, script: {}, staleRenders: [] },
      },
    ]);
    const props = {
      shotId: 'shot_1',
      index: 0,
      businessId: null,
      editable: true,
      onChanged: vi.fn(),
      onDeleted,
    };
    const { unmount } = renderWithSWR(<ShotSwapDelete {...props} isLastShot={false} />);
    await userEvent.click(screen.getByRole('button', { name: /Delete shot/ }));
    await userEvent.click(screen.getByRole('button', { name: /Confirm delete/ }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(api.find('DELETE', '/shots/shot_1')).toHaveLength(1);
    unmount();
    renderWithSWR(<ShotSwapDelete {...props} isLastShot />);
    expect(screen.getByRole('button', { name: /Delete shot/ })).toBeDisabled();
  });
});
