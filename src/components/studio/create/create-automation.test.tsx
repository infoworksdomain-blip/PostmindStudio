// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR, type MockRoute } from '../review/test-helpers';
import { CreateScreen } from './create-screen';

// Create screen: project templates (spec 8.6 / 14.5) and "Auto-publish when approved".

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/new' }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const template = {
  id: 'tpl_intro',
  organisationId: null,
  builtIn: true,
  name: 'Introduce yourself and what you do',
  category: 'introduction',
  targetFormats: [
    { platform: 'tiktok', aspectRatio: '9:16', duration: 30 },
    { platform: 'instagram_reel', aspectRatio: '9:16', duration: 30 },
  ],
  shotBlueprint: { shots: [{}, {}, {}, {}, {}] },
  publishDefaults: { publishPolicy: 'MANUAL', targets: [] },
  createdAt: '2026-09-27T00:00:00Z',
};

function routes(metaConnect: 'core' | 'studio' = 'core'): MockRoute[] {
  return [
    { match: '/brand-kits', body: { ok: true, data: [] } },
    {
      match: '/platform-connections',
      body: {
        ok: true,
        data: [
          {
            id: 'conn_tt',
            businessId: 'biz_1',
            platform: 'tiktok',
            platformAccountName: 'Acme TikTok',
            state: 'active',
          },
          {
            id: 'conn_old',
            businessId: 'biz_1',
            platform: 'tiktok',
            platformAccountName: 'Old account',
            state: 'needs_reconnect',
          },
        ],
        meta: { connect: metaConnect, configured: true },
      },
    },
    { match: '/templates', body: { ok: true, data: [template] } },
    { method: 'POST', match: '/projects', status: 201, body: { ok: true, project: { id: 'p1' } } },
    {
      method: 'POST',
      match: '/projects/p1/generate',
      status: 202,
      body: { ok: true, projectId: 'p1', state: 'QUEUED' },
    },
  ];
}

beforeEach(() => {
  push.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('CreateScreen — templates and auto-publish', () => {
  it('creates a TEMPLATE project with no brief, and the template’s formats', async () => {
    const api = mockFetch(routes());
    renderWithSWR(<CreateScreen initialReference={null} />);
    await userEvent.click(screen.getByRole('button', { name: /Options/ }));
    await userEvent.click(await screen.findByRole('radio', { name: /Introduce yourself/ }));
    expect(screen.getByText(/Platforms and length come from the template/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Long')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/p1'));
    const body = api.find('POST', '/projects')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      sourceType: 'TEMPLATE',
      templateId: 'tpl_intro',
      name: 'Introduce yourself and what you do',
    });
    expect(body.targetFormats).toBeUndefined();
    expect(body.brief).toBeUndefined();
  });

  it('auto-publish lists only active connections and sends the chosen targets', async () => {
    const api = mockFetch(routes());
    renderWithSWR(<CreateScreen initialReference={null} />);
    await userEvent.type(screen.getByLabelText('What’s the video about?'), 'Weekend offer');
    // 20.12: the picker is in the main form; the only active TikTok account is pre-selected.
    expect(await screen.findByLabelText(/Auto-publish when approved/)).toBeChecked();
    const select = screen.getByLabelText('TikTok account');
    await waitFor(() => expect(select).toHaveValue('conn_tt'));
    expect(screen.queryByRole('option', { name: 'Old account' })).not.toBeInTheDocument();

    // Nothing chosen → a clear problem naming the platform instead of a request.
    await userEvent.selectOptions(select, '');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick the TikTok account to post to');
    expect(api.find('POST', '/projects')).toHaveLength(0);

    await userEvent.selectOptions(select, 'conn_tt');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    const body = api.find('POST', '/projects')[0]?.body as Record<string, unknown>;
    expect(body.publishPolicy).toBe('AUTO_ON_APPROVAL');
    expect(body.autoPublish).toEqual({
      targets: [{ platform: 'tiktok', connectionId: 'conn_tt' }],
    });
  });

  it('says Instagram is not posted and points to PostMind settings when none is connected', async () => {
    mockFetch(routes());
    renderWithSWR(<CreateScreen initialReference={null} />);
    await userEvent.click(screen.getByRole('button', { name: /Options/ }));
    await userEvent.click(await screen.findByRole('radio', { name: /Introduce yourself/ }));
    expect(screen.getByLabelText(/Auto-publish when approved/)).toBeChecked();
    expect(screen.queryByLabelText('Instagram Reels account')).not.toBeInTheDocument();
    expect(
      screen.getByText(/Not posted automatically \(no connected account\): Instagram Reels\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Connect Instagram and Facebook in PostMind settings/),
    ).toBeInTheDocument();
  });

  it('standalone: points to Connections, never to PostMind settings (Phase 18)', async () => {
    mockFetch(routes('studio'));
    renderWithSWR(<CreateScreen initialReference={null} />);
    await userEvent.click(screen.getByRole('button', { name: /Options/ }));
    await userEvent.click(await screen.findByRole('radio', { name: /Introduce yourself/ }));
    expect(screen.queryByLabelText('Instagram Reels account')).not.toBeInTheDocument();
    expect(screen.queryByText(/PostMind settings/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect an account' })).toHaveAttribute(
      'href',
      '/connections',
    );
  });
});
