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

function routes(): MockRoute[] {
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
    await userEvent.click(screen.getByRole('button', { name: /Options/ }));
    await userEvent.click(screen.getByLabelText(/Auto-publish when approved/));
    const select = await screen.findByLabelText('TikTok account');
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Acme TikTok' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('option', { name: 'Old account' })).not.toBeInTheDocument();

    // Nothing chosen yet → a clear problem instead of a request.
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one account');
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

  it('offers Instagram auto-publish and points to PostMind settings when none is connected', async () => {
    mockFetch(routes());
    renderWithSWR(<CreateScreen initialReference={null} />);
    await userEvent.click(screen.getByRole('button', { name: /Options/ }));
    await userEvent.click(await screen.findByRole('radio', { name: /Introduce yourself/ }));
    await userEvent.click(screen.getByLabelText(/Auto-publish when approved/));
    expect(screen.queryByText(/not available for auto-publish/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Instagram Reels account')).toBeDisabled();
    expect(
      screen.getByText(/Connect Instagram and Facebook in PostMind settings/),
    ).toBeInTheDocument();
  });
});
