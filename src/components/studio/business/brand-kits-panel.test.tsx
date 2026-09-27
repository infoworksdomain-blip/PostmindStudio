// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrandKit } from '@/lib/client/types';
import { fail, mockFetch, ok, renderScreen } from '../publications/test-utils';
import { BrandKitsPanel } from './brand-kits-panel';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const kit = (overrides: Partial<BrandKit>): BrandKit => ({
  id: 'kit_1',
  businessId: 'biz_1',
  name: 'Main',
  isDefault: true,
  colourPalette: ['#D6452B'],
  fontPrimary: 'Inter',
  fontSecondary: null,
  toneKeywords: ['warm'],
  audienceProfile: null,
  ctaTemplates: [],
  restrictedTopics: [],
  ...overrides,
});

describe('BrandKitsPanel', () => {
  it('lists kits for the business and shows the default', async () => {
    const api = mockFetch(() =>
      ok({ data: [kit({}), kit({ id: 'kit_2', name: 'Summer', isDefault: false })] }),
    );
    renderScreen(<BrandKitsPanel businessId="biz_1" />);
    const list = await screen.findByRole('list', { name: 'Brand kits' });
    expect(within(list).getByText('Default')).toBeInTheDocument();
    expect(
      within(list).getByRole('button', { name: 'Make Summer the default' }),
    ).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Make Main the default' })).toBeNull();
    expect(api.requests[0]!.url.searchParams.get('businessId')).toBe('biz_1');
  });

  it('shows empty and error states', async () => {
    mockFetch(() => ok({ data: [] }));
    const { unmount } = renderScreen(<BrandKitsPanel businessId="biz_1" />);
    expect(await screen.findByText('No brand kit yet')).toBeInTheDocument();
    unmount();
    mockFetch(() => fail(500, 'Kits down'));
    renderScreen(<BrandKitsPanel businessId="biz_1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Kits down');
  });

  it('creates a kit with validated fields', async () => {
    const api = mockFetch((req) =>
      req.method === 'POST' ? ok({ brandKit: kit({}) }) : ok({ data: [] }),
    );
    const user = userEvent.setup();
    renderScreen(<BrandKitsPanel businessId="biz_1" />);
    await user.click(await screen.findByRole('button', { name: 'New brand kit' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Autumn');
    await user.type(within(dialog).getByLabelText('Colours'), '#abc');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('#abc is not a #RRGGBB colour.');
    expect(within(dialog).getByRole('button', { name: 'Create kit' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Colours'), 'def, #112233');
    await user.type(within(dialog).getByLabelText('Tone'), 'cosy, bold');
    await user.type(within(dialog).getByLabelText('Calls to action'), 'Shop | Shop now at {{url}');
    await user.click(within(dialog).getByRole('button', { name: 'Create kit' }));

    await waitFor(() => expect(api.find('POST', '/brand-kits')).toHaveLength(1));
    expect(api.find('POST', '/brand-kits')[0]!.body).toEqual({
      businessId: 'biz_1',
      name: 'Autumn',
      colourPalette: ['#ABCDEF', '#112233'],
      fontPrimary: null,
      fontSecondary: null,
      toneKeywords: ['cosy', 'bold'],
      audienceProfile: null,
      ctaTemplates: [{ label: 'Shop', template: 'Shop now at {url}' }],
      restrictedTopics: [],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('edits, sets default and deletes (after confirming)', async () => {
    const api = mockFetch((req) =>
      req.method === 'GET'
        ? ok({ data: [kit({ id: 'kit_2', name: 'Summer', isDefault: false })] })
        : ok({ brandKit: kit({}), deleted: true }),
    );
    const user = userEvent.setup();
    renderScreen(<BrandKitsPanel businessId="biz_1" />);

    await user.click(await screen.findByRole('button', { name: 'Edit Summer' }));
    const dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Heading font'));
    await user.type(within(dialog).getByLabelText('Heading font'), 'Instrument Serif');
    await user.click(within(dialog).getByRole('button', { name: 'Save kit' }));
    await waitFor(() => expect(api.find('PATCH', '/brand-kits/kit_2')).toHaveLength(1));
    expect(api.find('PATCH', '/brand-kits/kit_2')[0]!.body).toMatchObject({
      name: 'Summer',
      fontPrimary: 'Instrument Serif',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Make Summer the default' }));
    await waitFor(() => expect(api.find('POST', '/brand-kits/kit_2/set-default')).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: 'Delete Summer' }));
    const confirm = await screen.findByRole('dialog');
    expect(api.find('DELETE', '/brand-kits/kit_2')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Delete kit' }));
    await waitFor(() => expect(api.find('DELETE', '/brand-kits/kit_2')).toHaveLength(1));
  });
});
