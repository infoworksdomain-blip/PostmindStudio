// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR, type MockRoute } from '../review/test-helpers';
import { CreateScreen } from './create-screen';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/new' }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const kits = {
  ok: true,
  data: [
    { id: 'kit_1', name: 'Main kit', isDefault: true },
    { id: 'kit_2', name: 'Alt kit', isDefault: false },
  ],
};
const connections = {
  ok: true,
  data: [
    {
      id: 'c1',
      businessId: 'biz_1',
      platform: 'youtube',
      platformAccountName: 'Acme',
      state: 'active',
    },
  ],
};

function routes(extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { match: '/brand-kits', body: kits },
    { match: '/platform-connections', body: connections },
    {
      match: '/slideshow-templates',
      body: {
        ok: true,
        data: [
          {
            id: 'tpl_1',
            organisationId: null,
            name: 'Listicle 5',
            category: 'listicle_5',
            slidePlan: [{}, {}, {}],
            musicMood: null,
            defaultDurationPerSlide: 2.5,
          },
        ],
      },
    },
    { method: 'POST', match: '/projects', status: 201, body: { ok: true, project: { id: 'p9' } } },
    {
      method: 'POST',
      match: '/projects/p9/generate',
      status: 202,
      body: { ok: true, projectId: 'p9', state: 'QUEUED' },
    },
  ];
}

beforeEach(() => {
  push.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('CreateScreen', () => {
  it('asks for a business when none is selected', () => {
    mockFetch(routes());
    renderWithSWR(<CreateScreen initialReference={null} />, '');
    expect(screen.getByText('Pick a business first')).toBeInTheDocument();
  });

  it('creates and generates from one text box and one button', async () => {
    const api = mockFetch(routes());
    renderWithSWR(<CreateScreen initialReference={null} />);
    await userEvent.type(screen.getByLabelText('What’s the video about?'), 'Spring menu launch');
    await waitFor(() => expect(screen.getByText(/brand kit on/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/p9'));
    const [create] = api.find('POST', '/projects');
    expect(create?.body).toEqual({
      name: 'Spring menu launch',
      businessId: 'biz_1',
      sourceType: 'BRIEF',
      targetFormats: [{ platform: 'youtube_short', aspectRatio: '9:16', durationSec: 45 }],
      brief: { rawInput: 'Spring menu launch' },
      brandKitId: 'kit_1',
    });
    expect(create?.headers['idempotency-key']).toBeTruthy();
    expect(api.find('POST', '/projects/p9/generate')).toHaveLength(1);
    expect(toast.success).toHaveBeenCalled();
  });

  it('shows validation problems instead of submitting an empty brief', async () => {
    const api = mockFetch(routes());
    renderWithSWR(<CreateScreen initialReference={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Describe what the video is about.');
    expect(api.find('POST', '/projects')).toHaveLength(0);
  });

  it('applies options: platforms, length, no brand kit, advanced budget', async () => {
    const api = mockFetch(routes());
    renderWithSWR(<CreateScreen initialReference={null} />);
    await userEvent.type(screen.getByLabelText('What’s the video about?'), 'Launch');
    await userEvent.click(screen.getByRole('button', { name: /Options/ }));
    await userEvent.click(screen.getByLabelText('TikTok'));
    await userEvent.click(screen.getByLabelText('Long'));
    await waitFor(() => expect(screen.getByLabelText('Brand kit')).toHaveValue('kit_1'));
    await userEvent.selectOptions(screen.getByLabelText('Brand kit'), '');
    await userEvent.click(screen.getByRole('button', { name: 'Advanced options' }));
    await userEvent.type(screen.getByLabelText('Budget cap (£)'), '12.50');
    await userEvent.selectOptions(screen.getByLabelText('Approval'), 'AUTO_APPROVE');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    const body = api.find('POST', '/projects')[0]?.body as Record<string, unknown>;
    expect(body.targetFormats).toEqual([
      { platform: 'tiktok', aspectRatio: '9:16', durationSec: 90 },
      { platform: 'youtube_short', aspectRatio: '9:16', durationSec: 60 },
    ]);
    expect(body.brandKitId).toBeUndefined();
    expect(body.costBudgetPence).toBe(1250);
    expect(body.reviewPolicy).toBe('AUTO_APPROVE');
  });

  it('creates a slideshow from a template without starting generation', async () => {
    const api = mockFetch(routes());
    renderWithSWR(<CreateScreen initialReference={null} />);
    await userEvent.type(screen.getByLabelText('What’s the video about?'), 'Five cafe tips');
    await userEvent.click(screen.getByRole('button', { name: /Options/ }));
    await userEvent.click(screen.getByRole('radio', { name: /Slideshow/ }));
    await userEvent.click(await screen.findByRole('radio', { name: /Listicle 5/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create slideshow' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/p9'));
    const body = api.find('POST', '/projects')[0]?.body as Record<string, unknown>;
    expect(body.sourceType).toBe('SLIDESHOW');
    expect(body.slideshow).toEqual({ templateId: 'tpl_1', topic: 'Five cafe tips' });
    expect(body.brief).toBeUndefined();
    expect(api.find('POST', '/projects/p9/generate')).toHaveLength(0);
  });

  it('uses a library reference from the query string', async () => {
    const api = mockFetch(
      routes([
        {
          match: '/library/videos/lib_1',
          body: {
            ok: true,
            video: {
              id: 'lib_1',
              title: 'Barista hook',
              allowedModes: ['INSPIRE', 'TEMPLATE'],
              durationSec: 20,
            },
          },
        },
      ]),
    );
    renderWithSWR(<CreateScreen initialReference={{ id: 'lib_1', mode: 'INSPIRE' }} />);
    expect(await screen.findByText('Barista hook')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Template' }));
    await userEvent.type(screen.getByLabelText('What’s the video about?'), 'Our coffee');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    const body = api.find('POST', '/projects')[0]?.body as Record<string, unknown>;
    expect(body.sourceType).toBe('LIBRARY_REFERENCE');
    expect(body.referenceVideoId).toBe('lib_1');
    expect(body.referenceMode).toBe('TEMPLATE');
  });

  it('reports an API error and stays on the page', async () => {
    mockFetch([
      {
        method: 'POST',
        match: '/projects',
        status: 400,
        body: { ok: false, error: 'validation_error', message: 'Budget too low' },
      },
      ...routes(),
    ]);
    renderWithSWR(<CreateScreen initialReference={null} />);
    await userEvent.type(screen.getByLabelText('What’s the video about?'), 'Launch');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Budget too low'));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });
});
