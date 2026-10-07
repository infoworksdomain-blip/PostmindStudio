// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR, type MockRoute } from '../review/test-helpers';
import { CreateScreen } from './create-screen';

// 20.12 — "platforms" (formats to render) vs "accounts" (connected social accounts to post to),
// on every Create tab: (a) no connected account, (b) accounts that post none of the chosen
// platforms, (c) a matching account. Plus the production screenshot of 2026-10-01: Slideshow,
// 9 platforms, brief filled, no connected account → "Create slideshow" must not be blocked.

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/create' }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const TIKTOK = {
  id: 'conn_tt',
  businessId: 'biz_1',
  platform: 'tiktok',
  platformAccountName: 'Ahead TikTok',
  state: 'active',
};
const LINKEDIN = {
  id: 'conn_li',
  businessId: 'biz_1',
  platform: 'linkedin',
  platformAccountName: 'Ahead LinkedIn',
  state: 'active',
};

const NINE = [
  'TikTok',
  'Instagram Reels',
  'YouTube Shorts',
  'YouTube',
  'LinkedIn',
  'X',
  'Facebook Reels',
  'Instagram feed',
  'Facebook feed',
];

function routes(connections: unknown[]): MockRoute[] {
  return [
    { match: '/brand-kits', body: { ok: true, data: [] } },
    {
      match: '/platform-connections',
      body: { ok: true, data: connections, meta: { connect: 'studio', configured: true } },
    },
    { match: '/templates', body: { ok: true, data: [] } },
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
    { method: 'POST', match: '/projects', status: 201, body: { ok: true, project: { id: 'p1' } } },
    {
      method: 'POST',
      match: '/projects/p1/generate',
      status: 202,
      body: { ok: true, projectId: 'p1', state: 'QUEUED' },
    },
    {
      method: 'POST',
      match: '/uploads',
      status: 201,
      body: {
        ok: true,
        upload: {
          id: 'upl_1',
          putUrl: 'https://s3.test/uploads/upl_1?sig',
          headers: { 'content-type': 'video/mp4' },
        },
      },
    },
    { method: 'PUT', match: /s3\.test/, body: {} },
    {
      method: 'POST',
      match: '/uploads/upl_1/complete',
      body: {
        ok: true,
        upload: { id: 'upl_1', state: 'READY', fileName: 'shop-tour.mp4', durationSec: 20 },
        asset: null,
      },
    },
  ];
}

type Tab = 'Video' | 'Slideshow' | 'Upload a video';

async function openTab(tab: Tab) {
  await userEvent.click(screen.getByRole('button', { name: /Options/ }));
  if (tab !== 'Video') await userEvent.click(screen.getByRole('radio', { name: tab }));
}

async function fill(tab: Tab) {
  if (tab === 'Slideshow') {
    await userEvent.type(screen.getByLabelText('What’s the slideshow about?'), 'AheadAi launch');
    await userEvent.click(await screen.findByRole('radio', { name: /Listicle 5/ }));
  } else if (tab === 'Upload a video') {
    const file = new File([new Uint8Array(20)], 'shop-tour.mp4', { type: 'video/mp4' });
    await userEvent.upload(screen.getByLabelText('Choose a video'), file);
    await screen.findByLabelText('Replace the video');
  } else {
    await userEvent.type(screen.getByLabelText('What’s the video about?'), 'AheadAi launch');
  }
}

const submitName = (tab: Tab) => (tab === 'Slideshow' ? 'Create slideshow' : 'Generate');

async function choosePlatforms(labels: string[]) {
  for (const label of NINE) {
    const chip = screen.getByRole('checkbox', { name: label });
    const checked = chip.getAttribute('aria-checked') === 'true';
    if (checked !== labels.includes(label)) await userEvent.click(chip);
  }
}

beforeEach(() => {
  push.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('20.12 regression: the operator’s screenshot (2026-10-01)', { timeout: 60_000 }, () => {
  it('Slideshow, 9 platforms, no connected account: creates the slideshow for review', async () => {
    const api = mockFetch(routes([]));
    renderWithSWR(<CreateScreen initialReference={null} />);
    await openTab('Slideshow');
    await choosePlatforms(NINE);
    await fill('Slideshow');
    // The summary and the form say there is no account, instead of claiming "auto-publish".
    expect(
      await screen.findByText(/No connected accounts — slideshows are saved for review/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect an account' })).toHaveAttribute(
      'href',
      '/connections',
    );
    const summary = screen.getByRole('button', { name: /Options/ });
    expect(summary).toHaveTextContent('9 platforms · Short · no connected accounts');
    expect(summary).not.toHaveTextContent('auto-publish');
    expect(screen.queryByLabelText(/Auto-publish when approved/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Create slideshow' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/p1'));
    expect(screen.queryByText(/Choose at least one account/)).not.toBeInTheDocument();
    const body = api.find('POST', '/projects')[0]?.body as Record<string, unknown>;
    expect(body.sourceType).toBe('SLIDESHOW');
    expect(body.targetFormats).toHaveLength(9);
    expect(body.publishPolicy).toBeUndefined();
    expect(body.autoPublish).toBeUndefined();
  });
});

describe.each<Tab>(['Video', 'Slideshow', 'Upload a video'])(
  '20.12 Create — %s tab',
  { timeout: 60_000 },
  (tab) => {
    it('(a) no connected account: auto-publish is off, the work is saved for review', async () => {
      const api = mockFetch(routes([]));
      renderWithSWR(<CreateScreen initialReference={null} />);
      await openTab(tab);
      await fill(tab);
      expect(await screen.findByText(/No connected accounts —/)).toBeInTheDocument();
      // Scheduling posts automatically, so it explains why it is unavailable.
      await userEvent.click(screen.getByRole('button', { name: 'Advanced options' }));
      expect(screen.getByLabelText('Schedule')).toBeDisabled();
      expect(
        screen.getByText(/A schedule posts automatically, so it needs a connected account/),
      ).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: submitName(tab) }));
      await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/p1'));
      const body = api.find('POST', '/projects')[0]?.body as Record<string, unknown>;
      expect(body.publishPolicy).toBeUndefined();
      expect(body.autoPublish).toBeUndefined();
    });

    it('(b) accounts that post none of the chosen platforms: off by default, and says so', async () => {
      const api = mockFetch(routes([TIKTOK]));
      renderWithSWR(<CreateScreen initialReference={null} />);
      await openTab(tab);
      await choosePlatforms(['X']);
      await fill(tab);
      const postTo = await screen.findByRole('group', { name: 'Post to' });
      expect(within(postTo).getByLabelText(/Auto-publish when approved/)).not.toBeChecked();
      expect(postTo).toHaveTextContent(
        'None of your connected accounts posts to the platforms chosen above. Your accounts post to TikTok.',
      );
      expect(screen.getByRole('button', { name: /Options/ })).toHaveTextContent('saved for review');

      // Turning it on anyway names what is missing instead of "choose an account".
      await userEvent.click(within(postTo).getByLabelText(/Auto-publish when approved/));
      await userEvent.click(screen.getByRole('button', { name: submitName(tab) }));
      expect(screen.getByRole('alert')).toHaveTextContent(
        'None of your connected accounts posts to the platforms you chose. Add TikTok',
      );
      expect(api.find('POST', '/projects')).toHaveLength(0);

      await userEvent.click(within(postTo).getByLabelText(/Auto-publish when approved/));
      await userEvent.click(screen.getByRole('button', { name: submitName(tab) }));
      await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/p1'));
      expect((api.find('POST', '/projects')[0]?.body as Record<string, unknown>).autoPublish).toBe(
        undefined,
      );
    });

    it('(c) a matching account: shown in the main form, pre-selected and sent', async () => {
      const api = mockFetch(routes([TIKTOK, LINKEDIN]));
      renderWithSWR(<CreateScreen initialReference={null} />);
      // The picker is visible without opening Options (only the tab switch needs Options).
      const postTo = await screen.findByRole('group', { name: 'Post to' });
      expect(within(postTo).getByLabelText(/Auto-publish when approved/)).toBeChecked();
      await openTab(tab);
      await choosePlatforms(['TikTok', 'LinkedIn', 'X']);
      await fill(tab);
      expect(within(postTo).getByLabelText('TikTok account')).toHaveValue('conn_tt');
      expect(within(postTo).getByLabelText('LinkedIn account')).toHaveValue('conn_li');
      expect(postTo).toHaveTextContent('Not posted automatically (no connected account): X.');
      expect(screen.getByRole('button', { name: /Options/ })).toHaveTextContent(
        'posts to 2 accounts',
      );
      // Unpicking every account names the platforms to pick.
      await userEvent.selectOptions(within(postTo).getByLabelText('TikTok account'), '');
      await userEvent.selectOptions(within(postTo).getByLabelText('LinkedIn account'), '');
      await userEvent.click(screen.getByRole('button', { name: submitName(tab) }));
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Pick the TikTok or LinkedIn account to post to under “Post to”, or turn auto-publish off.',
      );
      await userEvent.selectOptions(within(postTo).getByLabelText('TikTok account'), 'conn_tt');

      await userEvent.click(screen.getByRole('button', { name: submitName(tab) }));
      await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/p1'));
      const body = api.find('POST', '/projects')[0]?.body as Record<string, unknown>;
      expect(body.publishPolicy).toBe('AUTO_ON_APPROVAL');
      expect(body.autoPublish).toEqual({
        targets: [{ platform: 'tiktok', connectionId: 'conn_tt' }],
      });
    });
  },
);

describe('20.12 Create — switching business', () => {
  it('never keeps an account chosen for another business', async () => {
    mockFetch(
      routes([
        TIKTOK,
        { ...TIKTOK, id: 'conn_tt_2', platformAccountName: 'Second TikTok' },
        { ...TIKTOK, id: 'conn_other', businessId: 'biz_2', platformAccountName: 'Other biz' },
      ]),
    );
    renderWithSWR(<CreateScreen initialReference={null} />);
    const postTo = await screen.findByRole('group', { name: 'Post to' });
    // Two TikTok accounts for this business: nothing is guessed, so auto-publish starts off
    // and the owner picks one.
    const toggle = within(postTo).getByLabelText(/Auto-publish when approved/);
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    const select = within(postTo).getByLabelText('TikTok account');
    expect(select).toHaveValue('');
    expect(within(postTo).queryByRole('option', { name: 'Other biz' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Options/ })).toHaveTextContent(
      'auto-publish: no account picked',
    );
  });
});
