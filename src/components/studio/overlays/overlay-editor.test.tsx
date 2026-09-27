// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeProject, mockFetch, renderWithSWR, type MockRoute } from '../review/test-helpers';
import { OverlayEditor } from './overlay-editor';
import { makeOverlay, PRESETS } from './test-fixtures';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
afterEach(() => vi.unstubAllGlobals());

function routes(extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { match: '/overlay-presets', body: { ok: true, data: PRESETS } },
    { match: '/shots/shot_1/overlays', body: { ok: true, data: [makeOverlay()] } },
    { match: '/shots/shot_2/overlays', body: { ok: true, data: [] } },
  ];
}

describe('OverlayEditor', () => {
  it('loads presets for the business and the first shot’s overlays', async () => {
    const api = mockFetch(routes());
    renderWithSWR(<OverlayEditor project={makeProject()} businessId="biz_1" onChanged={vi.fn()} />);
    expect(
      await screen.findByRole('button', { name: /Overlay “Wait for it”/ }),
    ).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === '/overlay-presets')?.query.get('businessId')).toBe(
      'biz_1',
    );
    await userEvent.click(screen.getByRole('button', { name: /Shot 2,/ }));
    expect(await screen.findByText('No overlays on this shot yet.')).toBeInTheDocument();
  });

  it('applies a whole-video overlay to a render', async () => {
    const onChanged = vi.fn();
    const api = mockFetch(
      routes([
        {
          method: 'POST',
          match: '/renders/ren_1/overlays/bulk',
          status: 201,
          body: { ok: true, data: [makeOverlay({ id: 'ov_w', renderId: 'ren_1', shotId: null })] },
        },
      ]),
    );
    renderWithSWR(
      <OverlayEditor project={makeProject()} businessId="biz_1" onChanged={onChanged} />,
    );
    await userEvent.type(await screen.findByLabelText('Text', { selector: '#bulk-text' }), '@cafe');
    await userEvent.clear(screen.getByLabelText('End (s)', { selector: '#bulk-end' }));
    await userEvent.type(screen.getByLabelText('End (s)', { selector: '#bulk-end' }), '12');
    await userEvent.selectOptions(
      screen.getByLabelText('Preset', { selector: '#bulk-preset' }),
      'pre_cta',
    );
    await userEvent.click(screen.getByRole('button', { name: /Apply overlay/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.find('POST', '/renders/ren_1/overlays/bulk')[0]?.body).toEqual({
      overlay: { text: '@cafe', startAtSec: 0, endAtSec: 12, presetId: 'pre_cta' },
    });
    expect(toast.success).toHaveBeenCalledWith('Added 1 overlay.');
  });

  it('applies one overlay to selected shots', async () => {
    const api = mockFetch(
      routes([
        {
          method: 'POST',
          match: '/renders/ren_1/overlays/bulk',
          status: 201,
          body: { ok: true, data: [makeOverlay(), makeOverlay({ id: 'ov_2' })] },
        },
      ]),
    );
    renderWithSWR(<OverlayEditor project={makeProject()} businessId="biz_1" onChanged={vi.fn()} />);
    await userEvent.type(await screen.findByLabelText('Text', { selector: '#bulk-text' }), 'Tip');
    await userEvent.click(screen.getByLabelText(/Selected shots/));
    const apply = screen.getByRole('button', { name: /Apply overlay/ });
    expect(apply).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Shot 1'));
    await userEvent.click(screen.getByLabelText('Shot 2'));
    await userEvent.click(apply);
    await waitFor(() => expect(api.find('POST', '/renders/ren_1/overlays/bulk')).toHaveLength(1));
    expect(api.find('POST', '/renders/ren_1/overlays/bulk')[0]?.body).toEqual({
      overlay: { text: 'Tip', startAtSec: 0, endAtSec: 2 },
      applyToShotIds: ['shot_1', 'shot_2'],
    });
  });

  it('re-renders with the current overlays', async () => {
    const onChanged = vi.fn();
    const api = mockFetch(
      routes([
        {
          method: 'POST',
          match: '/renders/ren_1/rerender',
          status: 202,
          body: { ok: true, projectId: 'proj_1', runId: 'run_2' },
        },
      ]),
    );
    renderWithSWR(
      <OverlayEditor project={makeProject()} businessId="biz_1" onChanged={onChanged} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: /Re-render video/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.find('POST', '/renders/ren_1/rerender')).toHaveLength(1);
  });

  it('disables re-render and editing outside the editable states', async () => {
    mockFetch(routes());
    renderWithSWR(
      <OverlayEditor
        project={makeProject({ state: 'PUBLISHED' })}
        businessId="biz_1"
        onChanged={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(/Overlays are read-only while the project is published/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-render video/ })).toBeDisabled();
  });

  it('explains when there are no shots yet', () => {
    mockFetch(routes());
    renderWithSWR(
      <OverlayEditor
        project={makeProject({ scripts: [] })}
        businessId="biz_1"
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText(/Overlays can be added once the script/)).toBeInTheDocument();
  });
});
