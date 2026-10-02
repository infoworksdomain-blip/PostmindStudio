// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fail,
  mockFetch,
  ok,
  renderScreen,
  type RecordedRequest,
} from '../publications/test-utils';
import { BusinessScreen } from './business-screen';
import { ConnectionsScreen } from '../connections/connections-screen';

// QA 6: a role that may not write sees the controls disabled (and why), not buttons that end in
// a permission toast; owners and admins are unaffected.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
afterEach(() => vi.unstubAllGlobals());

const VIEWER = ['studio:project:read'];
const OWNER = [
  'studio:project:read',
  'studio:project:write',
  'studio:connections:manage',
  'studio:business:manage',
];

const profile = {
  id: 'p1',
  businessId: 'biz_1',
  industry: 'Food',
  subNiche: 'bakery',
  products: [],
  services: [],
  audienceKeywords: [],
  toneIndicators: [],
  regions: [],
  imageThemes: [],
  imageSearchQueries: ['bread'],
  restrictedTopics: [],
  brandVoiceSummary: null,
  classifierModel: 'm',
  lastRefreshedAt: '2026-09-01T10:00:00.000Z',
  editedByUser: false,
};

const connection = (over: Record<string, unknown>) => ({
  id: 'con_1',
  businessId: 'biz_1',
  platform: 'tiktok',
  platformAccountId: 'tt',
  platformAccountName: '@bakery',
  accessTokenExpiresAt: null,
  scopes: [],
  state: 'active',
  connectedAt: '2026-09-01T10:00:00.000Z',
  ...over,
});

function serve(capabilities: string[]) {
  return mockFetch((req: RecordedRequest) => {
    const path = req.url.pathname;
    if (path === '/api/studio/me')
      return ok({ me: { capabilities, user: { platformRole: 'user' } } });
    if (path.endsWith('/business-profile')) return ok({ profile });
    if (path.endsWith('/scans') || path === '/api/studio/brand-kits') return ok({ data: [] });
    if (path === '/api/studio/image-library') return ok({ data: [], nextCursor: null });
    if (path === '/api/studio/platform-connections') return ok({ data: [connection({})] });
    return fail(404, 'nope', 'not_found');
  });
}

describe('BusinessScreen for a viewer', () => {
  beforeEach(() => {
    serve(VIEWER);
  });

  it('says it is view-only and disables the profile form', async () => {
    renderScreen(<BusinessScreen />);
    expect(await screen.findByRole('note')).toHaveTextContent('view-only access');
    expect(await screen.findByLabelText('Industry')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
  });

  it('disables the scan form, new brand kits and the image library actions', async () => {
    const user = userEvent.setup();
    renderScreen(<BusinessScreen />);
    await user.click(await screen.findByRole('tab', { name: 'Website scan' }));
    expect(await screen.findByLabelText('Website address')).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: 'Brand kits' }));
    expect(await screen.findByRole('button', { name: 'New brand kit' })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: 'Image library' }));
    expect(await screen.findByRole('button', { name: 'Upload' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh stock' })).toBeDisabled();
    // Reading stays possible: the search box is not part of the gate.
    expect(screen.getByLabelText('Search images by meaning')).toBeEnabled();
  });
});

describe('BusinessScreen for an owner', () => {
  it('has no view-only note and an enabled profile form', async () => {
    serve(OWNER);
    renderScreen(<BusinessScreen />);
    expect(await screen.findByLabelText('Industry')).toBeEnabled();
    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('ConnectionsScreen', () => {
  it('a viewer cannot connect or disconnect and is told who can', async () => {
    serve(VIEWER);
    renderScreen(<ConnectionsScreen />);
    expect(await screen.findByRole('note')).toHaveTextContent('Only owners and admins');
    expect(await screen.findByRole('button', { name: 'Disconnect @bakery' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Connect X' })).toBeDisabled();
  });

  it('an owner can', async () => {
    serve(OWNER);
    renderScreen(<ConnectionsScreen />);
    expect(await screen.findByRole('button', { name: 'Disconnect @bakery' })).toBeEnabled();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('a stale account of a platform without settings is not offered a Reconnect that cannot work', async () => {
    mockFetch((req: RecordedRequest) => {
      if (req.url.pathname === '/api/studio/me')
        return ok({ me: { capabilities: OWNER, user: { platformRole: 'user' } } });
      return ok({
        data: [
          connection({
            id: 'con_li',
            platform: 'linkedin',
            platformAccountName: 'Bakery Ltd',
            state: 'needs_reconnect',
          }),
          connection({
            id: 'con_yt',
            platform: 'youtube',
            platformAccountName: 'Bakery TV',
            state: 'needs_reconnect',
          }),
        ],
        configured: { linkedin: false, youtube: true },
      });
    });
    renderScreen(<ConnectionsScreen />);
    const linkedin = await screen.findByRole('region', { name: 'LinkedIn' });
    expect(within(linkedin).getByText('Needs reconnecting')).toBeInTheDocument();
    expect(within(linkedin).queryByRole('button', { name: /Reconnect/ })).toBeNull();
    expect(within(linkedin).getByText(/not available yet/)).toBeInTheDocument();
    const youtube = screen.getByRole('region', { name: 'YouTube' });
    expect(within(youtube).getByRole('button', { name: /Reconnect/ })).toBeInTheDocument();
  });
});
