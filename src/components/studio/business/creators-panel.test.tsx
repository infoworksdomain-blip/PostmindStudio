// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Creator } from '../creators/types';
import { mockFetch, ok, renderScreen } from '../publications/test-utils';
import { CreatorsPanel } from './creators-panel';

// BACKLOG 22.3 — Business → Creators: the grid of portraits, creating a generated creator, the
// upload path that needs the consent checkbox, regenerate with changes, make default and retire.
// Never a cost.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
afterEach(() => vi.unstubAllGlobals());

const creator = (over: Partial<Creator> = {}): Creator => ({
  id: 'cr_1',
  businessId: 'biz_1',
  name: 'Maya',
  gender: 'woman',
  ageRange: '25-34',
  setting: 'kitchen',
  appearance: 'short curly hair',
  voiceTone: 'warm',
  status: 'READY',
  isDefault: false,
  useCount: 3,
  lastUsedAt: null,
  portraitError: null,
  portraitSource: 'GENERATED',
  portraitUrl: 'https://cdn.test/maya.png',
  createdAt: '2026-10-01T00:00:00.000Z',
  retiredAt: null,
  ...over,
});

const PATH = '/api/studio/businesses/biz_1/creators';

describe('CreatorsPanel (22.3)', () => {
  it('shows the creators as a grid of portraits with status, uses and the default; no cost', async () => {
    mockFetch(() =>
      ok({
        data: [
          creator({ isDefault: true }),
          creator({
            id: 'cr_2',
            name: 'Tom',
            status: 'DRAFT',
            useCount: 0,
            portraitUrl: null,
            portraitError: 'content_policy',
          }),
        ],
      }),
    );
    renderScreen(<CreatorsPanel businessId="biz_1" />);
    const list = await screen.findByRole('list', { name: 'Creators' });
    expect(within(list).getByRole('img', { name: 'Portrait of Maya' })).toBeInTheDocument();
    expect(within(list).getByText('Month-plan default')).toBeInTheDocument();
    expect(within(list).getByText(/No portrait could be made this time/)).toBeInTheDocument();
    expect(within(list).getByText(/Videos: 3/)).toBeInTheDocument();
    expect(screen.getByTestId('creator-count')).toHaveTextContent('2 of 20');
    expect(document.body.textContent).not.toMatch(/£|\$/);
  });

  it('creates a generated creator from the presets and look notes', async () => {
    const user = userEvent.setup();
    const api = mockFetch((req) =>
      req.method === 'POST' && req.url.pathname === PATH
        ? { status: 201, body: { ok: true, creator: creator({ id: 'cr_9', name: 'Ava' }) } }
        : ok({ data: [] }),
    );
    renderScreen(<CreatorsPanel businessId="biz_1" />);
    await user.click(await screen.findByRole('button', { name: 'New creator' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Ava');
    await user.selectOptions(within(dialog).getByLabelText('Age'), '18-24');
    await user.type(within(dialog).getByLabelText('Look (optional)'), 'freckles, red hair');
    await user.click(within(dialog).getByRole('button', { name: 'Create and generate portrait' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Ava is ready'));
    const [post] = api.find('POST', '/businesses/biz_1/creators');
    expect(post?.body).toEqual({
      name: 'Ava',
      gender: 'woman',
      ageRange: '18-24',
      setting: 'kitchen',
      appearance: 'freckles, red hair',
    });
  });

  it('an upload needs a PNG/JPEG photo and the consent checkbox, then sends consent=true', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const api = mockFetch((req) =>
      req.method === 'POST' && req.url.pathname === `${PATH}/upload`
        ? { status: 201, body: { ok: true, creator: creator({ portraitSource: 'UPLOAD' }) } }
        : ok({ data: [] }),
    );
    renderScreen(<CreatorsPanel businessId="biz_1" />);
    await user.click(await screen.findByRole('button', { name: 'New creator' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'Upload a photo' }));
    await user.type(within(dialog).getByLabelText('Name'), 'Amara');
    const submit = within(dialog).getByRole('button', { name: 'Create from photo' });
    expect(submit).toBeDisabled();
    await user.upload(
      within(dialog).getByLabelText(/^Photo/),
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'amara.png', { type: 'image/png' }),
    );
    expect(submit).toBeDisabled();
    expect(within(dialog).getByText(/Tick the box to confirm/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('checkbox'));
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() =>
      expect(api.find('POST', '/businesses/biz_1/creators/upload')).toHaveLength(1),
    );
    const form = api.find('POST', '/businesses/biz_1/creators/upload')[0]?.body as FormData;
    expect(form.get('consent')).toBe('true');
    expect(form.get('name')).toBe('Amara');
    expect(form.get('photo')).toBeInstanceOf(File);
  });

  it('regenerates with changes, makes a creator the default and retires one', async () => {
    const user = userEvent.setup();
    const api = mockFetch((req) => {
      if (req.method === 'GET') return ok({ data: [creator()] });
      return ok({ creator: creator() });
    });
    renderScreen(<CreatorsPanel businessId="biz_1" />);
    await user.click(
      await screen.findByRole('button', { name: 'Regenerate the portrait of Maya' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Changes (optional)'), 'a bigger smile');
    await user.click(within(dialog).getByRole('button', { name: 'Regenerate' }));
    await waitFor(() =>
      expect(api.find('POST', '/businesses/biz_1/creators/cr_1/regenerate')[0]?.body).toEqual({
        instructions: 'a bigger smile',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Use Maya for month plans' }));
    await waitFor(() =>
      expect(api.find('PATCH', '/businesses/biz_1/creators/cr_1')[0]?.body).toEqual({
        isDefault: true,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Retire Maya' }));
    const confirm = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await user.click(within(confirm).getByRole('button', { name: 'Retire' }));
    await waitFor(() =>
      expect(api.find('POST', '/businesses/biz_1/creators/cr_1/retire')).toHaveLength(1),
    );
  });
});
