// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeProject, makeRender, mockFetch, renderWithSWR } from '../review/test-helpers';
import { SlideOverlays } from '../slideshow/slide-overlays';
import { ShotOverlays } from './shot-overlays';
import { makeOverlay, PRESETS } from './test-fixtures';
import { WholeVideoOverlays } from './whole-video-overlays';

// 13.3 whole-video lane, 13.4 slide overlay panel, 13.7 undo/redo, resize handle, alpha colour,
// safe-area guides and editing presets.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const overlayName = 'Overlay “Wait for it”, 0.5s to 2.5s';

function renderShot(platform = 'instagram_reel') {
  return renderWithSWR(
    <ShotOverlays
      shotId="shot_1"
      duration={5}
      aspectRatio="9:16"
      platform={platform}
      editable
      presets={PRESETS}
      businessId="biz_1"
      onPresetsChanged={vi.fn()}
    />,
  );
}

describe('overlay editor polish (13.7)', () => {
  it('undoes and redoes style changes (buttons and Ctrl+Z / Ctrl+Shift+Z)', async () => {
    mockFetch([{ match: '/shots/shot_1/overlays', body: { ok: true, data: [makeOverlay()] } }]);
    renderShot();
    await userEvent.click(await screen.findByRole('button', { name: overlayName }));
    const size = screen.getByLabelText(/Size \(5% of height\)/);
    fireEvent.change(size, { target: { value: '9' } });
    expect(screen.getByLabelText(/Size \(9% of height\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Undo$/ }));
    expect(screen.getByLabelText(/Size \(5% of height\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Redo$/ }));
    expect(screen.getByLabelText(/Size \(9% of height\)/)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText(/Size \(9% of height\)/), { key: 'z', ctrlKey: true });
    expect(screen.getByLabelText(/Size \(5% of height\)/)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText(/Size \(5% of height\)/), {
      key: 'z',
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.getByLabelText(/Size \(9% of height\)/)).toBeInTheDocument();
  });

  it('resizes the selected overlay with its handle (keyboard)', async () => {
    mockFetch([{ match: '/shots/shot_1/overlays', body: { ok: true, data: [makeOverlay()] } }]);
    renderShot();
    await userEvent.click(await screen.findByRole('button', { name: overlayName }));
    fireEvent.change(screen.getByLabelText('Playhead position (seconds)'), {
      target: { value: '1' },
    });
    const handle = screen.getByRole('button', { name: /Resize overlay \(5% of frame height\)/ });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(screen.getByLabelText(/Size \(5.5% of height\)/)).toBeInTheDocument();
  });

  it('sets a text colour with transparency and saves it as #rrggbbaa', async () => {
    const api = mockFetch([
      { match: '/shots/shot_1/overlays', body: { ok: true, data: [makeOverlay()] } },
      { method: 'PATCH', match: '/overlays/ov_1', body: { ok: true, overlay: makeOverlay() } },
    ]);
    renderShot();
    await userEvent.click(await screen.findByRole('button', { name: overlayName }));
    const [opacity] = screen.getAllByLabelText('Opacity (%)');
    if (!opacity) throw new Error('no opacity slider');
    fireEvent.change(opacity, { target: { value: '50' } });
    await userEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(api.find('PATCH', '/overlays/ov_1')).toHaveLength(1));
    expect(api.find('PATCH', '/overlays/ov_1')[0]?.body).toEqual({
      style: { fillColor: '#ffffff80' },
    });
  });

  it('outlines the platform safe area and says when it is only a conservative margin', async () => {
    mockFetch([{ match: '/shots/shot_1/overlays', body: { ok: true, data: [] } }]);
    const { unmount } = renderShot('instagram_reel');
    expect(await screen.findByText('Instagram Reels safe zone (Meta)')).toBeInTheDocument();
    expect(screen.getByTestId('safe-area')).toHaveStyle({ top: '14%', bottom: '35%' });
    unmount();
    renderShot('tiktok');
    expect(await screen.findByText(/TikTok — conservative margin/)).toBeInTheDocument();
  });

  it('edits one of your presets with PATCH /overlay-presets/:id', async () => {
    const onPresetsChanged = vi.fn();
    const api = mockFetch([
      { match: '/shots/shot_1/overlays', body: { ok: true, data: [makeOverlay()] } },
      { method: 'PATCH', match: '/overlay-presets/pre_cta', body: { ok: true, preset: {} } },
    ]);
    renderWithSWR(
      <ShotOverlays
        shotId="shot_1"
        duration={5}
        aspectRatio="9:16"
        editable
        presets={PRESETS}
        businessId="biz_1"
        onPresetsChanged={onPresetsChanged}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: overlayName }));
    await userEvent.click(screen.getByText('Edit your presets'));
    await userEvent.selectOptions(
      screen.getByLabelText('Preset', { selector: 'select[id$="edit-preset"]' }),
      'pre_cta',
    );
    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Big CTA');
    await userEvent.click(screen.getByRole('button', { name: /Save name/ }));
    await waitFor(() => expect(onPresetsChanged).toHaveBeenCalled());
    expect(api.find('PATCH', '/overlay-presets/pre_cta')[0]?.body).toEqual({
      name: 'Big CTA',
      group: 'cta',
    });
    await userEvent.click(screen.getByRole('button', { name: /Use this overlay’s style/ }));
    await waitFor(() => expect(api.find('PATCH', '/overlay-presets/pre_cta')).toHaveLength(2));
    expect(api.find('PATCH', '/overlay-presets/pre_cta')[1]?.body).toMatchObject({
      parameters: expect.objectContaining({ fontFamily: 'Montserrat' }),
    });
  });
});

describe('Whole video lane (13.3)', () => {
  it('lists the render’s whole-video overlays and adds one with the bulk endpoint', async () => {
    const watermark = makeOverlay({
      id: 'ov_w',
      shotId: null,
      renderId: 'ren_1',
      text: '@leedssourdough',
      startAtSec: 0,
      endAtSec: 12,
    });
    const api = mockFetch([
      { match: '/renders/ren_1/overlays', body: { ok: true, data: [watermark] } },
      {
        method: 'POST',
        match: '/renders/ren_1/overlays/bulk',
        status: 201,
        body: { ok: true, data: [makeOverlay({ id: 'ov_new', renderId: 'ren_1' })] },
      },
    ]);
    renderWithSWR(
      <WholeVideoOverlays
        project={makeProject({ renders: [makeRender()] })}
        editable
        presets={PRESETS}
        businessId="biz_1"
        onPresetsChanged={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole('button', { name: 'Overlay “@leedssourdough”, 0.0s to 12.0s' }),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('New overlay text'), 'Order online');
    await userEvent.click(screen.getByRole('button', { name: /Add at playhead/ }));
    await waitFor(() => expect(api.find('POST', '/renders/ren_1/overlays/bulk')).toHaveLength(1));
    expect(api.find('POST', '/renders/ren_1/overlays/bulk')[0]?.body).toEqual({
      overlay: { text: 'Order online', startAtSec: 0, endAtSec: 2 },
    });
    expect(screen.queryByRole('button', { name: /Preview render/ })).not.toBeInTheDocument();
  });

  it('explains that a variant must render first', () => {
    mockFetch([]);
    renderWithSWR(
      <WholeVideoOverlays
        project={makeProject({ renders: [] })}
        editable
        presets={PRESETS}
        businessId="biz_1"
        onPresetsChanged={vi.fn()}
      />,
    );
    expect(screen.getByText(/once a variant has rendered/)).toBeInTheDocument();
  });
});

describe('Slide overlays (13.4)', () => {
  it('adds an overlay to a slide with POST /slides/:id/overlays', async () => {
    const api = mockFetch([
      { match: '/overlay-presets', body: { ok: true, data: PRESETS } },
      { match: '/slides/sl_1/overlays', body: { ok: true, data: [] } },
      {
        method: 'POST',
        match: '/slides/sl_1/overlays',
        status: 201,
        body: { ok: true, overlay: makeOverlay({ id: 'ov_s', shotId: null, slideId: 'sl_1' }) },
      },
    ]);
    renderWithSWR(
      <SlideOverlays
        slideId="sl_1"
        duration={3}
        aspectRatio="9:16"
        platform="tiktok"
        editable
        businessId="biz_1"
      />,
    );
    const panel = screen.getByText('Text overlays on this slide').closest('details');
    if (!panel) throw new Error('no panel');
    await userEvent.click(screen.getByText('Text overlays on this slide'));
    await userEvent.type(await within(panel).findByLabelText('New overlay text'), 'Bake #3');
    await userEvent.click(within(panel).getByRole('button', { name: /Add at playhead/ }));
    await waitFor(() => expect(api.find('POST', '/slides/sl_1/overlays')).toHaveLength(1));
    expect(api.find('POST', '/slides/sl_1/overlays')[0]?.body).toEqual({
      text: 'Bake #3',
      startAtSec: 0,
      endAtSec: 2,
    });
  });
});
