// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, mockFetch, ok, renderScreen } from '../publications/test-utils';
import { ProfilePanel } from './profile-panel';
import type { BusinessProfile } from './types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const PROFILE: BusinessProfile = {
  id: 'bp_1',
  businessId: 'biz_1',
  industry: 'Pet supplies',
  subNiche: 'Cat toys',
  products: ['scratching posts', 'catnip'],
  services: [],
  audienceKeywords: ['cat owners'],
  toneIndicators: ['playful'],
  regions: ['UK'],
  imageThemes: ['cats playing'],
  imageSearchQueries: ['cat toy'],
  restrictedTopics: [],
  brandVoiceSummary: 'Warm and funny.',
  classifierModel: 'claude-sonnet',
  lastRefreshedAt: '2026-09-20T10:00:00.000Z',
  editedByUser: false,
};

describe('ProfilePanel', () => {
  it('offers a website scan when there is no profile yet (404)', async () => {
    mockFetch(() => fail(404, 'No business profile yet: run a website scan first', 'not_found'));
    const onGoToScan = vi.fn();
    const user = userEvent.setup();
    renderScreen(<ProfilePanel businessId="biz_1" onGoToScan={onGoToScan} />);
    await user.click(await screen.findByRole('button', { name: 'Scan your website' }));
    expect(onGoToScan).toHaveBeenCalled();
  });

  it('shows other errors', async () => {
    mockFetch(() => fail(500, 'Boom'));
    renderScreen(<ProfilePanel businessId="biz_1" onGoToScan={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Boom');
  });

  it('shows the classification and PATCHes only changed fields', async () => {
    const api = mockFetch((req) =>
      req.method === 'PATCH' ? ok({ profile: PROFILE }) : ok({ profile: PROFILE }),
    );
    const user = userEvent.setup();
    renderScreen(<ProfilePanel businessId="biz_1" onGoToScan={vi.fn()} />);
    expect(await screen.findByText(/Classified by claude-sonnet/)).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save profile' });
    expect(save).toBeDisabled();

    await user.clear(screen.getByLabelText('Niche'));
    await user.type(screen.getByLabelText('Niche'), 'Cat furniture');
    await user.type(screen.getByLabelText('Products'), ', cat trees, catnip');
    await user.click(save);

    await waitFor(() =>
      expect(api.find('PATCH', '/businesses/biz_1/business-profile')).toHaveLength(1),
    );
    expect(api.find('PATCH', '/businesses/biz_1/business-profile')[0]!.body).toEqual({
      subNiche: 'Cat furniture',
      products: ['scratching posts', 'catnip', 'cat trees'],
    });
  });

  it('blocks saving without a stock image search', async () => {
    mockFetch(() => ok({ profile: PROFILE }));
    const user = userEvent.setup();
    renderScreen(<ProfilePanel businessId="biz_1" onGoToScan={vi.fn()} />);
    await user.clear(await screen.findByLabelText('Stock image searches'));
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    expect(screen.getByText(/at least one stock image search/)).toBeInTheDocument();
  });
});
