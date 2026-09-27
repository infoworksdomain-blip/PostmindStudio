// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR, type MockRoute } from '../review/test-helpers';
import { ShotOverlays } from './shot-overlays';
import { makeOverlay, PRESETS } from './test-fixtures';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const list = (overlays = [makeOverlay()]): MockRoute => ({
  match: '/shots/shot_1/overlays',
  body: { ok: true, data: overlays },
});

function renderEditor(editable = true) {
  return renderWithSWR(
    <ShotOverlays
      shotId="shot_1"
      duration={5}
      aspectRatio="9:16"
      editable={editable}
      presets={PRESETS}
      businessId="biz_1"
      onPresetsChanged={vi.fn()}
    />,
  );
}

describe('ShotOverlays', () => {
  it('shows loading, then the timeline and live frame', async () => {
    mockFetch([list()]);
    renderEditor();
    expect(screen.getByLabelText('Loading overlays')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Overlay “Wait for it”, 0.5s to 2.5s' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Frame at 0.0s: no overlays/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Playhead position (seconds)'), {
      target: { value: '1' },
    });
    expect(screen.getByRole('img', { name: /Frame at 1.0s: Wait for it/ })).toBeInTheDocument();
  });

  it('shows the error state', async () => {
    mockFetch([
      {
        match: '/shots/shot_1/overlays',
        status: 500,
        body: { ok: false, error: 'internal', message: 'Boom' },
      },
    ]);
    renderEditor();
    expect(await screen.findByText('Boom')).toBeInTheDocument();
  });

  it('adds an overlay with a preset at the playhead', async () => {
    const api = mockFetch([
      list([]),
      {
        method: 'POST',
        match: '/shots/shot_1/overlays',
        status: 201,
        body: { ok: true, overlay: makeOverlay({ id: 'ov_new' }) },
      },
    ]);
    renderEditor();
    expect(await screen.findByText('No overlays on this shot yet.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Playhead position (seconds)'), {
      target: { value: '1.5' },
    });
    await userEvent.type(screen.getByLabelText('New overlay text'), 'Wait for it');
    await userEvent.selectOptions(screen.getByLabelText('Preset'), 'pre_hook');
    await userEvent.click(screen.getByRole('button', { name: /Add at playhead/ }));
    await waitFor(() => expect(api.find('POST', '/shots/shot_1/overlays')).toHaveLength(1));
    expect(api.find('POST', '/shots/shot_1/overlays')[0]?.body).toEqual({
      text: 'Wait for it',
      startAtSec: 1.5,
      endAtSec: 3.5,
      presetId: 'pre_hook',
    });
  });

  it('edits text, style and timing (keyboard) and saves only the changes', async () => {
    const api = mockFetch([
      list(),
      { method: 'PATCH', match: '/overlays/ov_1', body: { ok: true, overlay: makeOverlay() } },
    ]);
    renderEditor();
    const bar = await screen.findByRole('button', { name: /Overlay “Wait for it”/ });
    await userEvent.click(bar);
    const text = screen.getByLabelText('Text');
    await userEvent.clear(text);
    await userEvent.type(text, 'Big news');
    await userEvent.selectOptions(screen.getByLabelText('Animation in'), 'popIn');
    bar.focus();
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await userEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(api.find('PATCH', '/overlays/ov_1')).toHaveLength(1));
    expect(api.find('PATCH', '/overlays/ov_1')[0]?.body).toEqual({
      text: 'Big news',
      startAtSec: 1,
      endAtSec: 3.1,
      style: { animationIn: 'popIn' },
    });
  });

  it('blocks saving an invalid draft and can discard it', async () => {
    mockFetch([list()]);
    renderEditor();
    await userEvent.click(await screen.findByRole('button', { name: /Overlay “Wait for it”/ }));
    await userEvent.clear(screen.getByLabelText('Text'));
    expect(screen.getByRole('alert')).toHaveTextContent('Text can’t be empty.');
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /Discard changes/ }));
    expect(screen.getByLabelText('Text')).toHaveValue('Wait for it');
  });

  it('renders a server preview of the saved overlay', async () => {
    const api = mockFetch([
      list(),
      {
        method: 'POST',
        match: '/overlays/ov_1/preview',
        body: {
          ok: true,
          preview: {
            url: 'https://cdn.test/p.mp4',
            expiresInSec: 600,
            range: { start: 0, length: 3 },
          },
        },
      },
    ]);
    renderEditor();
    await userEvent.click(await screen.findByRole('button', { name: /Overlay “Wait for it”/ }));
    await userEvent.click(screen.getByRole('button', { name: /Preview render/ }));
    expect(await screen.findByLabelText('Overlay preview render')).toHaveAttribute(
      'src',
      'https://cdn.test/p.mp4',
    );
    expect(api.find('POST', '/overlays/ov_1/preview')).toHaveLength(1);
  });

  it('deletes an overlay', async () => {
    const api = mockFetch([
      list(),
      { method: 'DELETE', match: '/overlays/ov_1', body: { ok: true, deleted: true } },
    ]);
    renderEditor();
    await userEvent.click(await screen.findByRole('button', { name: /Overlay “Wait for it”/ }));
    await userEvent.click(screen.getByRole('button', { name: /Delete/ }));
    await waitFor(() => expect(api.find('DELETE', '/overlays/ov_1')).toHaveLength(1));
  });

  it('saves the current style as a business preset', async () => {
    const api = mockFetch([
      list(),
      { method: 'POST', match: '/overlay-presets', status: 201, body: { ok: true, preset: {} } },
    ]);
    renderEditor();
    await userEvent.click(await screen.findByRole('button', { name: /Overlay “Wait for it”/ }));
    await userEvent.type(screen.getByLabelText('Save this style as a preset'), 'My hook');
    await userEvent.selectOptions(screen.getByLabelText('Group'), 'cta');
    await userEvent.click(screen.getByRole('button', { name: /Save preset/ }));
    await waitFor(() => expect(api.find('POST', '/overlay-presets')).toHaveLength(1));
    const body = api.find('POST', '/overlay-presets')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      name: 'My hook',
      group: 'cta',
      scope: 'business',
      businessId: 'biz_1',
    });
    expect(body.parameters).toMatchObject({ fontFamily: 'Montserrat', anchorX: 0.5 });
  });

  it('is read-only when the project cannot be edited', async () => {
    mockFetch([list()]);
    renderEditor(false);
    await userEvent.click(await screen.findByRole('button', { name: /Overlay “Wait for it”/ }));
    expect(screen.getByLabelText('New overlay text')).toBeDisabled();
    expect(screen.getByLabelText('Text')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Delete/ })).toBeDisabled();
  });
});
