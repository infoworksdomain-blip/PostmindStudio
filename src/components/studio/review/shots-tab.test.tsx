// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShotsTab } from './shots-tab';
import { makeProject, mockFetch, renderWithSWR } from './test-helpers';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const shot = {
  id: 'shot_2',
  scriptId: 'scr_1',
  sortOrder: 1,
  durationSec: 7,
  visualTreatment: 'STOCK_FOOTAGE',
  state: 'READY',
  errorReason: null,
  sceneDescription: 'Chef plating a salad',
  cameraDirection: 'Slow push-in',
  voiceoverText: 'Fresh from the market',
  onScreenText: 'New!',
  transitionOut: null,
  assetId: 'a1',
  voiceAssetId: null,
  assets: [],
};

describe('ShotsTab', () => {
  it('asks to select a shot, then shows its detail', async () => {
    mockFetch([{ match: '/shots/shot_2', body: { ok: true, shot } }]);
    renderWithSWR(<ShotsTab project={makeProject()} onChanged={vi.fn()} />);
    expect(screen.getByText(/Select a shot/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Shot 2,/ }));
    expect(await screen.findByText('Chef plating a salad')).toBeInTheDocument();
    expect(screen.getByLabelText('Narration')).toHaveValue('Fresh from the market');
  });

  it('regenerates one shot with a prompt override', async () => {
    const onChanged = vi.fn();
    const api = mockFetch([
      { match: '/shots/shot_2', body: { ok: true, shot } },
      { method: 'POST', match: '/shots/shot_2/regenerate', status: 202, body: { ok: true } },
    ]);
    renderWithSWR(<ShotsTab project={makeProject()} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole('button', { name: /Shot 2,/ }));
    await userEvent.type(await screen.findByLabelText(/New prompt/), 'Overhead shot instead');
    await userEvent.click(screen.getByRole('button', { name: /Regenerate this shot/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.find('POST', '/shots/shot_2/regenerate')[0]?.body).toEqual({
      prompt: 'Overhead shot instead',
    });
  });

  it('saves narration and caption edits', async () => {
    const api = mockFetch([
      { match: '/shots/shot_2', body: { ok: true, shot } },
      { method: 'PATCH', match: '/shots/shot_2', status: 202, body: { ok: true } },
    ]);
    renderWithSWR(<ShotsTab project={makeProject()} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Shot 2,/ }));
    const caption = await screen.findByLabelText('On-screen text');
    await userEvent.clear(caption);
    await userEvent.click(screen.getByRole('button', { name: /Save text/ }));
    await waitFor(() =>
      expect(api.find('PATCH', '/shots/shot_2')[0]?.body).toEqual({
        voiceoverText: 'Fresh from the market',
        onScreenText: null,
      }),
    );
  });

  it('locks editing while the pipeline runs', async () => {
    mockFetch([{ match: '/shots/shot_2', body: { ok: true, shot } }]);
    renderWithSWR(<ShotsTab project={makeProject({ state: 'RENDERING' })} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Shot 2,/ }));
    expect(await screen.findByRole('button', { name: /Regenerate this shot/ })).toBeDisabled();
  });

  it('explains when there is no script yet', () => {
    mockFetch([]);
    renderWithSWR(<ShotsTab project={makeProject({ scripts: [] })} onChanged={vi.fn()} />);
    expect(screen.getByText('Shots appear once the script is written.')).toBeInTheDocument();
  });
});
