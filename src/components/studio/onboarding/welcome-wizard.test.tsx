// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import {
  fail,
  mockFetch,
  ok,
  renderScreen,
  type RecordedRequest,
  type Reply,
} from '../publications/test-utils';
import type { Onboarding, OnboardingPatch } from './onboarding';
import { WelcomeWizard } from './welcome-wizard';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // The business picker remembers the chosen business in localStorage (business-context.tsx).
  window.localStorage.clear();
});

const INTRO = {
  id: 'tpl_intro',
  organisationId: null,
  builtIn: true,
  name: 'Introduce yourself and what you do',
  category: 'intro',
  targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 30 }],
  shotBlueprint: null,
  publishDefaults: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function onboarding(over: Partial<Onboarding> = {}): Onboarding {
  return {
    step: 'brand_kit',
    completed: [],
    firstVideoProjectId: null,
    dismissedAt: null,
    startedAt: null,
    suggested: true,
    ...over,
  };
}

/** A stateful /onboarding plus per-test extra routes. */
function server(initial: Partial<Onboarding>, extra: (req: RecordedRequest) => Reply | undefined) {
  let state = onboarding(initial);
  return mockFetch((req) => {
    const path = req.url.pathname;
    if (path === '/api/studio/onboarding') {
      if (req.method === 'PATCH') {
        const { dismissed, ...rest } = req.body as OnboardingPatch;
        state = {
          ...state,
          ...rest,
          ...(dismissed !== undefined && {
            dismissedAt: dismissed ? '2026-09-27T10:00:00Z' : null,
          }),
        };
        state.suggested = !state.dismissedAt && state.step !== 'done';
      }
      return ok({ onboarding: state });
    }
    return extra(req);
  });
}

const patches = (api: ReturnType<typeof mockFetch>) =>
  api.find('PATCH', '/onboarding').map((r) => r.body);

describe('WelcomeWizard', () => {
  it('resumes from the server step and shows progress', async () => {
    server({ step: 'first_video', completed: ['brand_kit', 'connect'] }, (req) =>
      req.url.pathname.endsWith('/templates') ? ok({ data: [INTRO] }) : ok({ data: [] }),
    );
    renderScreen(<WelcomeWizard />);
    expect(await screen.findByRole('heading', { name: 'Make your first video' })).toBeVisible();
    const steps = within(screen.getByRole('list', { name: 'Setup progress' })).getAllByRole(
      'listitem',
    );
    // Phase 18: Organisation, Business, Brand kit, Connect, First video, Celebrate.
    expect(steps).toHaveLength(6);
    expect(steps.map((s) => s.textContent?.replace(/\(done\)|\d/g, '').trim())).toEqual([
      'Organisation',
      'Business',
      'Brand kit',
      'Connect',
      'First video',
      'Celebrate',
    ]);
    expect(steps[4]).toHaveAttribute('aria-current', 'step');
    expect(steps[0]).toHaveTextContent('(done)');
    expect(steps[3]).toHaveTextContent('(done)');
    expect(steps[5]).not.toHaveTextContent('(done)');
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();
  });

  it('continues past Connect once an account is connected and saves progress', async () => {
    const api = server({ step: 'connect', completed: ['brand_kit'] }, (req) => {
      if (req.url.pathname.endsWith('/templates')) return ok({ data: [INTRO] });
      if (req.url.pathname.endsWith('/platform-connections'))
        return ok({
          data: [
            {
              id: 'pc_1',
              businessId: 'biz_1',
              platform: 'tiktok',
              platformAccountName: '@leedssourdough',
              state: 'active',
            },
          ],
        });
      return ok({ data: [] });
    });
    const user = userEvent.setup();
    renderScreen(<WelcomeWizard />);
    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    expect(list).toHaveTextContent('@leedssourdough');
    await user.click(screen.getByRole('button', { name: /Continue/ }));
    await screen.findByRole('heading', { name: 'Make your first video' });
    expect(patches(api)).toEqual([{ step: 'first_video', completed: ['brand_kit', 'connect'] }]);
  });

  it('builds a brand kit from the logo palette, a font and tone chips', async () => {
    const api = server({ step: 'brand_kit', completed: [] }, (req) => {
      if (req.url.pathname.endsWith('/brand-kits/extract'))
        return ok({ palette: ['#2B1D14', '#C6452D', '#F3E7D3'], suggestedFont: null });
      if (req.url.pathname.endsWith('/brand-kits') && req.method === 'POST')
        return {
          status: 201,
          body: { ok: true, brandKit: { id: 'bk_1', name: 'Main brand kit', isDefault: true } },
        };
      if (req.url.pathname.endsWith('/brand-kits')) return ok({ data: [] });
      return undefined;
    });
    const user = userEvent.setup();
    renderScreen(<WelcomeWizard />);
    const logo = new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' });
    await user.upload(await screen.findByLabelText('Upload logo'), logo);

    const palette = await screen.findByRole('list', { name: 'Palette' });
    expect(within(palette).getAllByRole('listitem')).toHaveLength(3);
    const extract = api.find('POST', '/brand-kits/extract')[0]!;
    expect(extract.body).toBeInstanceOf(FormData);
    expect((extract.body as FormData).get('logo')).toBeInstanceOf(File);

    await user.click(within(palette).getByRole('button', { name: 'Remove #F3E7D3' }));
    await user.click(screen.getByRole('radio', { name: 'Fraunces' }));
    for (const tone of ['Warm', 'Playful', 'Bold']) {
      await user.click(screen.getByRole('button', { name: tone }));
    }
    expect(screen.getByRole('button', { name: 'Calm' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save brand kit' }));

    await waitFor(() => expect(api.find('POST', '/brand-kits')).toHaveLength(1));
    expect(api.find('POST', '/brand-kits')[0]!.body).toEqual({
      businessId: 'biz_1',
      name: 'Main brand kit',
      colourPalette: ['#2B1D14', '#C6452D'],
      fontPrimary: 'Fraunces',
      toneKeywords: ['warm', 'playful', 'bold'],
      isDefault: true,
    });
    expect(await screen.findByText('Main brand kit is ready')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Continue/ }));
    await waitFor(() =>
      expect(patches(api)).toEqual([{ step: 'connect', completed: ['brand_kit'] }]),
    );
  });

  it('rejects a logo that is not an image without uploading it', async () => {
    const api = server({ step: 'brand_kit' }, () => ok({ data: [] }));
    const user = userEvent.setup({ applyAccept: false });
    renderScreen(<WelcomeWizard />);
    const pdf = new File(['%PDF'], 'logo.pdf', { type: 'application/pdf' });
    await user.upload(await screen.findByLabelText('Upload logo'), pdf);
    expect(await screen.findByRole('alert')).toHaveTextContent('Upload a PNG, JPEG');
    expect(api.find('POST', '/brand-kits/extract')).toHaveLength(0);
  });

  it('creates the first video from the intro template and saves its id', async () => {
    const api = server({ step: 'first_video', completed: ['connect', 'brand_kit'] }, (req) => {
      const path = req.url.pathname;
      if (path.endsWith('/templates')) return ok({ data: [INTRO] });
      if (path.endsWith('/brand-kits'))
        return ok({ data: [{ id: 'bk_1', name: 'Main', isDefault: true }] });
      if (path === '/api/studio/projects' && req.method === 'POST')
        return { status: 201, body: { ok: true, project: { id: 'prj_1' } } };
      if (path.endsWith('/projects/prj_1/generate')) return ok({ project: { id: 'prj_1' } });
      if (path.endsWith('/projects/prj_1'))
        return ok({ project: { id: 'prj_1', name: INTRO.name, publications: [] } });
      return undefined;
    });
    const user = userEvent.setup();
    renderScreen(<WelcomeWizard />);
    await user.type(
      await screen.findByLabelText('Anything to mention? (optional)'),
      'Family bakery in Leeds',
    );
    await user.click(screen.getByRole('button', { name: 'Make my intro video' }));

    expect(await screen.findByRole('link', { name: /Open your video/ })).toHaveAttribute(
      'href',
      '/projects/prj_1',
    );
    expect(api.find('POST', '/projects')[0]!.body).toEqual({
      name: INTRO.name,
      businessId: 'biz_1',
      sourceType: 'TEMPLATE',
      templateId: 'tpl_intro',
      brief: { rawInput: 'Family bakery in Leeds' },
      brandKitId: 'bk_1',
    });
    expect(api.find('POST', '/projects/prj_1/generate')).toHaveLength(1);
    expect(patches(api)).toEqual([{ firstVideoProjectId: 'prj_1' }]);

    await user.click(screen.getByRole('button', { name: /Continue/ }));
    expect(await screen.findByRole('heading', { name: 'Nearly live' })).toBeVisible();
  });

  it('celebrates the first live publication and finishes', async () => {
    const api = server(
      {
        step: 'celebrate',
        completed: ['connect', 'brand_kit', 'first_video'],
        firstVideoProjectId: 'prj_1',
      },
      (req) =>
        req.url.pathname.endsWith('/projects/prj_1')
          ? ok({
              project: {
                id: 'prj_1',
                name: 'Meet the bakers',
                publications: [
                  { id: 'pub_1', platform: 'youtube_short', state: 'SCHEDULED' },
                  {
                    id: 'pub_2',
                    platform: 'tiktok',
                    state: 'PUBLISHED',
                    publishedAt: '2026-09-27T09:00:00Z',
                    platformUrl: 'https://www.tiktok.com/@leeds/video/1',
                  },
                ],
              },
            })
          : undefined,
    );
    const user = userEvent.setup();
    renderScreen(<WelcomeWizard />);
    expect(
      await screen.findByRole('heading', { name: 'You just went live on TikTok' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: /See it on TikTok/ })).toHaveAttribute(
      'href',
      'https://www.tiktok.com/@leeds/video/1',
    );
    await user.click(screen.getByRole('button', { name: /Finish/ }));
    expect(await screen.findByText('You’re all set')).toBeVisible();
    expect(patches(api)).toEqual([
      { step: 'done', completed: ['brand_kit', 'connect', 'first_video', 'celebrate'] },
    ]);
  });

  it('skips a step without marking it done, goes back, and skips setup', async () => {
    const api = server({ step: 'connect' }, (req) =>
      req.url.pathname.endsWith('/templates') ? ok({ data: [INTRO] }) : ok({ data: [] }),
    );
    const user = userEvent.setup();
    renderScreen(<WelcomeWizard />);
    expect(await screen.findByText('No accounts connected yet.')).toBeVisible();
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Skip this step' }));
    await screen.findByRole('heading', { name: 'Make your first video' });
    await user.click(screen.getByRole('button', { name: /Back/ }));
    await screen.findByRole('heading', { name: 'Connect where you post' });
    await user.click(screen.getByRole('button', { name: 'Skip setup' }));
    expect(await screen.findByText('Setup skipped')).toBeVisible();
    expect(patches(api)).toEqual([
      { step: 'first_video' },
      { step: 'connect' },
      { dismissed: true },
    ]);

    await user.click(screen.getByRole('button', { name: 'Resume setup' }));
    await screen.findByRole('heading', { name: 'Connect where you post' });
    expect(patches(api).at(-1)).toEqual({ dismissed: false });
  });

  it('shows load and save errors', async () => {
    mockFetch(() => fail(500, 'Onboarding down'));
    const { unmount } = renderScreen(<WelcomeWizard />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Onboarding down');
    unmount();

    mockFetch((req) => {
      if (req.url.pathname.endsWith('/onboarding'))
        return req.method === 'PATCH'
          ? fail(400, 'Nothing to update', 'validation_error')
          : ok({ onboarding: onboarding({ step: 'connect' }) });
      return ok({ data: [] });
    });
    const user = userEvent.setup();
    renderScreen(<WelcomeWizard />);
    await user.click(await screen.findByRole('button', { name: 'Skip this step' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Nothing to update'));
    expect(screen.getByRole('heading', { name: 'Connect where you post' })).toBeVisible();
  });

  it('asks for the first business, creates it and moves on to the brand kit', async () => {
    const api = server({}, (req) => {
      if (req.url.pathname === '/api/studio/businesses' && req.method === 'POST')
        return {
          status: 201,
          body: { ok: true, business: { id: 'biz_new', name: 'Leeds Sourdough' } },
        };
      return ok({ data: [] });
    });
    const user = userEvent.setup();
    renderScreen(<WelcomeWizard />, null);
    expect(await screen.findByRole('heading', { name: 'Add your first business' })).toBeVisible();
    const steps = within(screen.getByRole('list', { name: 'Setup progress' })).getAllByRole(
      'listitem',
    );
    expect(steps[1]).toHaveAttribute('aria-current', 'step');
    await user.type(screen.getByLabelText('Business name'), 'Leeds Sourdough');
    await user.type(screen.getByLabelText('Website (optional)'), 'leedssourdough.co.uk');
    await user.click(screen.getByRole('button', { name: 'Add business' }));
    expect(
      await screen.findByRole('heading', { name: 'Your brand in three clicks' }),
    ).toBeVisible();
    expect(api.find('POST', '/businesses')[0]!.body).toEqual({
      name: 'Leeds Sourdough',
      domain: 'leedssourdough.co.uk',
    });
  });

  it('lets the user pick an existing business', async () => {
    server({}, (req) =>
      req.url.pathname === '/api/studio/businesses'
        ? ok({ data: [{ id: 'biz_9', name: 'Harbour Coffee', domain: 'harbour.test' }] })
        : ok({ data: [] }),
    );
    const user = userEvent.setup();
    renderScreen(<WelcomeWizard />, null);
    await user.click(await screen.findByRole('button', { name: /Harbour Coffee/ }));
    expect(
      await screen.findByRole('heading', { name: 'Your brand in three clicks' }),
    ).toBeVisible();
  });

  it('keeps the Core pointer when the business list belongs to Core (501)', async () => {
    server({}, (req) =>
      req.url.pathname === '/api/studio/businesses'
        ? fail(501, 'waiting for Core list-businesses', 'not_implemented')
        : ok({ data: [] }),
    );
    renderScreen(<WelcomeWizard />, null);
    expect(await screen.findByText('Set up a business first')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go to Business' })).toHaveAttribute(
      'href',
      '/business',
    );
  });

  it('creates the organisation first when the user has none', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const api = mockFetch((req) => {
      const path = req.url.pathname;
      if (path === '/api/studio/me') return fail(403, 'No organisation', 'no_organisation');
      if (path === '/api/studio/organisations' && req.method === 'POST')
        return {
          status: 201,
          body: {
            ok: true,
            organisation: { id: 'org_1', name: 'Leeds Sourdough Ltd', slug: 'leeds' },
          },
        };
      return undefined;
    });
    const user = userEvent.setup();
    renderScreen(<WelcomeWizard />, null);
    expect(await screen.findByRole('heading', { name: 'Name your organisation' })).toBeVisible();
    await user.type(screen.getByLabelText('Organisation name'), 'Leeds Sourdough Ltd');
    await user.selectOptions(screen.getByLabelText('Country'), 'GB');
    await user.selectOptions(screen.getByLabelText('Default language'), 'fr');
    await user.click(screen.getByRole('button', { name: 'Create organisation' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/welcome'));
    expect(api.find('POST', '/organisations')[0]!.body).toEqual({
      name: 'Leeds Sourdough Ltd',
      country: 'GB',
      defaultLocale: 'fr',
    });
    // No onboarding state is read before the organisation exists.
    expect(api.find('GET', '/onboarding')).toHaveLength(0);
  });
});
