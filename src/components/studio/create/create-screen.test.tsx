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
      targetFormats: [{ platform: 'youtube_short', aspectRatio: '9:16', durationSec: 30 }],
      brief: { rawInput: 'Spring menu launch' },
      brandKitId: 'kit_1',
      // 20.12: the business's only YouTube account is pre-selected and auto-publish is on.
      publishPolicy: 'AUTO_ON_APPROVAL',
      autoPublish: { targets: [{ platform: 'youtube_short', connectionId: 'c1' }] },
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

  const meAs = (platformRole: string): MockRoute => ({
    match: '/me',
    body: { ok: true, me: { capabilities: [], user: { platformRole } } },
  });

  it('applies options: platforms, length, no brand kit, advanced budget (staff)', async () => {
    const api = mockFetch(routes([meAs('staff')]));
    renderWithSWR(<CreateScreen initialReference={null} />);
    await userEvent.type(screen.getByLabelText('What’s the video about?'), 'Launch');
    await userEvent.click(screen.getByRole('button', { name: /Options/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'TikTok' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Long' }));
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

  it('hides the budget from customers and leaves it to the server default', async () => {
    const api = mockFetch(routes([meAs('user')]));
    renderWithSWR(<CreateScreen initialReference={null} />);
    await userEvent.type(screen.getByLabelText('What’s the video about?'), 'Launch');
    await userEvent.click(screen.getByRole('button', { name: /Options/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Advanced options' }));
    await waitFor(() => expect(api.find('GET', '/me').length).toBeGreaterThan(0));
    expect(screen.getByLabelText('Approval')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Budget/)).not.toBeInTheDocument();
    expect(screen.queryByText(/£/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    const body = api.find('POST', '/projects')[0]?.body as Record<string, unknown>;
    expect(body.costBudgetPence).toBeUndefined();
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
    // 20.12: slideshows auto-publish like videos.
    expect(body.publishPolicy).toBe('AUTO_ON_APPROVAL');
    expect(body.autoPublish).toEqual({
      targets: [{ platform: 'youtube_short', connectionId: 'c1' }],
    });
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

  const referenceVideo: MockRoute = {
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
  };
  const blueprint: MockRoute = {
    match: '/library/blueprint/lib_1',
    body: {
      ok: true,
      libraryVideoId: 'lib_1',
      allowedModes: ['INSPIRE', 'TEMPLATE'],
      blueprint: {
        shotCount: 2,
        totalDurationSec: 20,
        shots: [
          {
            durationSec: 8,
            type: 'HOOK_TEXT_ON_STILL',
            overlayStyle: 'bold-centre',
            voiceoverPresent: false,
            hasOnScreenText: true,
          },
          {
            durationSec: 12,
            type: 'PRODUCT_SHOT',
            overlayStyle: 'none',
            voiceoverPresent: true,
            hasOnScreenText: false,
          },
        ],
        musicEnvelope: { bpm: 96, energy: 'medium', moodTag: 'warm' },
        transitionSequence: ['cut', 'cut'],
        hookPattern: 'question',
        structurePattern: 'hook-demo-cta',
        ctaPattern: 'visit',
        paceTag: 'medium',
      },
      styleSignature: {
        paceTag: 'medium',
        moodTag: 'warm',
        structurePattern: 'hook-demo-cta',
        musicGenreTag: 'acoustic',
      },
    },
  };

  it('previews the shot structure a TEMPLATE reference will follow', async () => {
    mockFetch(routes([referenceVideo, blueprint]));
    renderWithSWR(<CreateScreen initialReference={{ id: 'lib_1', mode: 'TEMPLATE' }} />);
    expect(await screen.findByRole('heading', { name: 'What Studio will follow' })).toBeVisible();
    const shots = await screen.findByRole('list', { name: 'Shot list' });
    expect(shots.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText('Hook text on still')).toBeInTheDocument();
  });

  it('previews only the style signature for an INSPIRE reference, and follows the mode', async () => {
    mockFetch(routes([referenceVideo, blueprint]));
    renderWithSWR(<CreateScreen initialReference={{ id: 'lib_1', mode: 'INSPIRE' }} />);
    expect(await screen.findByRole('heading', { name: 'What Studio will borrow' })).toBeVisible();
    expect(await screen.findByText('hook-demo-cta')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Shot list' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Template' }));
    expect(await screen.findByRole('list', { name: 'Shot list' })).toBeInTheDocument();
  });

  it('applies a project template chosen on /templates', async () => {
    mockFetch(
      routes([
        {
          match: '/templates',
          body: {
            ok: true,
            data: [
              {
                id: 'tpl_p1',
                organisationId: 'org_1',
                builtIn: false,
                name: 'Weekly special',
                category: 'weekly_special',
                targetFormats: [{ platform: 'TIKTOK', aspectRatio: '9:16', duration: 15 }],
                shotBlueprint: { shots: [{}, {}] },
                publishDefaults: null,
                createdAt: '2026-09-01T00:00:00Z',
              },
            ],
          },
        },
      ]),
    );
    renderWithSWR(
      <CreateScreen initialReference={null} initialTemplate={{ kind: 'project', id: 'tpl_p1' }} />,
    );
    const radio = await screen.findByRole('radio', { name: /Weekly special/ });
    await waitFor(() => expect(radio).toHaveAttribute('aria-checked', 'true'));
  });

  it('starts a slideshow from the slideshow template chosen on /templates', async () => {
    mockFetch(routes());
    renderWithSWR(
      <CreateScreen initialReference={null} initialTemplate={{ kind: 'slideshow', id: 'tpl_1' }} />,
    );
    const radio = await screen.findByRole('radio', { name: /Listicle 5/ });
    expect(radio).toHaveAttribute('aria-checked', 'true');
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
