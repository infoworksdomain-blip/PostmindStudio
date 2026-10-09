// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportScreen } from '../account/export-screen';
import { StyleMemoryPanel } from '../business/style-memory-panel';
import { fail, mockFetch, ok, renderScreen } from '../publications/test-utils';
import { TemplatesScreen } from '../templates/templates-screen';
import { PublicPreview } from './public-preview';
import { ShareLinksPanel } from './share-links-panel';

// Phase 15 track E screens: share links (15.E5 / P8), the public preview (RTL / CJK safe),
// /account/export (15.E1), /templates (15.E7) and style-memory editing (15.E6).

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ShareLinksPanel', () => {
  it('creates a link, shows it once, lists feedback and revokes', async () => {
    let links = [
      {
        id: 'sl_1',
        state: 'active',
        expiresAt: '2026-10-04T00:00:00.000Z',
        createdAt: '2026-10-01T00:00:00.000Z',
        viewCount: 3,
        comments: [
          {
            id: 'c1',
            authorName: 'سارة',
            authorEmail: 'sara@x.test',
            body: 'رائع',
            createdAt: '2026-10-01T00:00:00.000Z',
          },
        ],
      },
    ];
    const api = mockFetch((req) => {
      if (req.method === 'POST')
        return ok({ link: { id: 'sl_2', url: 'https://studio.test/p/tok' } });
      if (req.method === 'DELETE') {
        links = links.map((l) => ({ ...l, state: 'revoked' }));
        return ok({ link: { id: 'sl_1' } });
      }
      return ok({ data: links });
    });
    const user = userEvent.setup();
    renderScreen(<ShareLinksPanel projectId="prj_1" />);
    const feedback = await screen.findByRole('list', { name: 'Feedback' });
    expect(within(feedback).getByText('رائع')).toHaveAttribute('dir', 'auto');
    expect(feedback).toHaveTextContent('sara@x.test');
    await user.selectOptions(screen.getByLabelText('Link lasts'), '168');
    await user.click(screen.getByRole('button', { name: /Create link/ }));
    expect(await screen.findByText('https://studio.test/p/tok')).toBeInTheDocument();
    expect(api.find('POST', '/projects/prj_1/share-links')[0]?.body).toEqual({
      expiresInHours: 168,
    });
    await user.click(screen.getByRole('button', { name: /Revoke/ }));
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });
});

describe('PublicPreview', () => {
  const preview = {
    ok: true,
    project: { name: 'مرحبا بكم — 春のメニュー', state: 'READY_FOR_REVIEW' },
    variants: [
      {
        id: 'r1',
        platform: 'tiktok',
        aspectRatio: '9:16',
        durationSec: 15,
        videoUrl: 'https://cdn.test/r1.mp4',
      },
    ],
    comments: [
      { id: 'c1', authorName: 'राहुल', body: 'बहुत अच्छा', createdAt: '2026-10-01T00:00:00.000Z' },
    ],
    expiresAt: '2026-10-04T00:00:00.000Z',
    canApprove: false,
  };

  it('renders RTL / CJK / Devanagari text safely, has no approve button, and sends feedback', async () => {
    const api = mockFetch((req) =>
      req.method === 'POST' ? { status: 201, body: { ok: true, comment: {} } } : { body: preview },
    );
    const user = userEvent.setup();
    renderScreen(<PublicPreview token="tok" />);
    const title = await screen.findByRole('heading', { level: 1 });
    expect(title).toHaveTextContent('مرحبا بكم — 春のメニュー');
    expect(title).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('बहुत अच्छा')).toHaveAttribute('dir', 'auto');
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    await user.type(screen.getByLabelText('Your name'), 'Amal');
    await user.type(screen.getByRole('textbox', { name: 'Feedback' }), 'جميل');
    await user.click(screen.getByRole('button', { name: /Send feedback/ }));
    expect(await screen.findByRole('status')).toHaveTextContent('Thanks');
    const post = api.requests.find((r) => r.method === 'POST');
    expect(post?.url.pathname).toBe('/api/studio/public/share-links/tok/comments');
    expect(post?.body).toEqual({ authorName: 'Amal', body: 'جميل' });
  });

  it('shows a skeleton of the page while loading, not a lone spinner (26.2)', () => {
    vi.stubGlobal('fetch', () => new Promise(() => undefined));
    const { container } = renderScreen(<PublicPreview token="slow" />);
    expect(screen.getByRole('main', { name: 'Loading preview' })).toHaveAttribute('aria-busy');
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(3);
  });

  it('shows the unavailable page for a dead link', async () => {
    mockFetch(() => fail(404, 'This preview link is invalid or has expired'));
    renderScreen(<PublicPreview token="dead" />);
    expect(await screen.findByText('Preview unavailable')).toBeInTheDocument();
    expect(screen.getByText('This preview link is invalid or has expired')).toBeInTheDocument();
  });
});

describe('ExportScreen', () => {
  it('requests an export with the chosen groups and offers the download', async () => {
    let exports: unknown[] = [];
    const api = mockFetch((req) => {
      if (req.method === 'POST') {
        exports = [
          {
            id: 'exp_1',
            state: 'READY',
            include: ['projects'],
            createdAt: '2026-10-01T00:00:00Z',
            completedAt: null,
            expiresAt: null,
            bytes: 4096,
            errorReason: null,
          },
        ];
        return { status: 202, body: { ok: true, export: { id: 'exp_1', state: 'QUEUED' } } };
      }
      return ok({ data: exports });
    });
    const user = userEvent.setup();
    renderScreen(<ExportScreen />);
    expect(await screen.findByText('No exports yet')).toBeInTheDocument();
    for (const name of ['Analytics', 'Brand', 'Image library', 'Account', 'Billing'])
      await user.click(screen.getByRole('checkbox', { name }));
    await user.click(screen.getByRole('button', { name: /Request export/ }));
    await waitFor(() => expect(api.find('POST', '/account/export')).toHaveLength(1));
    expect(api.find('POST', '/account/export')[0]?.body).toEqual({ include: ['projects'] });
    expect(await screen.findByRole('button', { name: /Download/ })).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalled();
  });
});

describe('TemplatesScreen', () => {
  it('lists own templates, keeps built-ins read-only, and deletes', async () => {
    let slides = [
      {
        id: 'st_1',
        name: 'My listicle',
        category: 'listicle_5',
        organisationId: 'org',
        createdAt: '2026-10-01T00:00:00Z',
      },
      {
        id: 'st_b',
        name: 'Photo dump',
        category: 'photo_dump',
        organisationId: null,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    const api = mockFetch((req) => {
      if (req.method === 'DELETE') {
        slides = slides.filter((s) => s.id !== 'st_1');
        return ok({ deleted: true });
      }
      return req.url.pathname.endsWith('/slideshow-templates')
        ? ok({ data: slides })
        : ok({ data: [] });
    });
    const user = userEvent.setup();
    renderScreen(<TemplatesScreen />);
    await user.click(await screen.findByRole('button', { name: 'Delete My listicle' }));
    // Deleting asks first: cancelling leaves the template alone.
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete “My listicle”?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.find('DELETE', '/slideshow-templates/st_1')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Delete My listicle' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Delete template',
      }),
    );
    await waitFor(() => expect(api.find('DELETE', '/slideshow-templates/st_1')).toHaveLength(1));
    expect(await screen.findByText(/Save a slideshow as a template/)).toBeInTheDocument();
    expect(screen.getByText('Photo dump')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Photo dump' })).toBeNull();
  });
});

describe('TemplatesScreen preview and use', () => {
  const project = {
    id: 'tp_1',
    name: 'Weekly special',
    category: 'weekly_special',
    organisationId: 'org',
    createdAt: '2026-10-01T00:00:00Z',
    targetFormats: [{ platform: 'TIKTOK', aspectRatio: '9:16', duration: 15 }],
    shotBlueprint: {
      shots: [
        {
          durationSec: 5,
          type: 'HOOK_TEXT_ON_STILL',
          overlayStyle: 'bold-centre',
          voiceoverPresent: false,
          hasOnScreenText: true,
        },
        {
          durationSec: 10,
          type: 'PRODUCT_SHOT',
          overlayStyle: 'none',
          voiceoverPresent: true,
          hasOnScreenText: false,
        },
      ],
    },
    scriptTemplate: '{{brief}} Open with the special of the week.',
    publishDefaults: { publishPolicy: 'AUTO_ON_APPROVAL' },
  };
  const slideshow = {
    id: 'st_9',
    name: 'Menu board',
    category: 'photo_dump',
    organisationId: null,
    createdAt: '2026-01-01T00:00:00Z',
    slidePlan: [{}, {}, {}, {}],
    musicMood: 'upbeat',
    defaultDurationPerSlide: 2.5,
  };

  function mockTemplates() {
    return mockFetch((req) =>
      req.url.pathname.endsWith('/slideshow-templates')
        ? ok({ data: [slideshow] })
        : ok({ data: [project] }),
    );
  }

  it('previews a project template: formats, shot structure and outline', async () => {
    mockTemplates();
    const user = userEvent.setup();
    renderScreen(<TemplatesScreen />);
    await user.click(await screen.findByRole('button', { name: 'Preview Weekly special' }));
    const dialog = await screen.findByRole('dialog', { name: /Weekly special/ });
    expect(within(dialog).getByRole('list', { name: 'Formats' })).toHaveTextContent('9:16');
    expect(
      within(dialog).getByRole('list', { name: 'Shot list' }).querySelectorAll('li'),
    ).toHaveLength(2);
    expect(within(dialog).getByText(/Open with the special of the week/)).toBeInTheDocument();
    expect(within(dialog).getByText('Publishes automatically once approved.')).toBeInTheDocument();
  });

  it('previews a built-in slideshow template: slides, pacing and music', async () => {
    mockTemplates();
    const user = userEvent.setup();
    renderScreen(<TemplatesScreen />);
    await user.click(await screen.findByRole('button', { name: 'Preview Menu board' }));
    const dialog = await screen.findByRole('dialog', { name: /Menu board/ });
    expect(within(dialog).getByText('4 slides')).toBeInTheDocument();
    expect(within(dialog).getByText('2.5s per slide')).toBeInTheDocument();
    expect(within(dialog).getByText('upbeat')).toBeInTheDocument();
  });

  it('opens Create with the template applied', async () => {
    mockTemplates();
    renderScreen(<TemplatesScreen />);
    expect(await screen.findByRole('link', { name: 'Use Weekly special' })).toHaveAttribute(
      'href',
      '/new?template=tp_1',
    );
    expect(screen.getByRole('link', { name: 'Use Menu board' })).toHaveAttribute(
      'href',
      '/new?slideshowTemplate=st_9',
    );
  });
});

describe('StyleMemoryPanel editing (15.E6)', () => {
  it('edits, pins and turns a memory off', async () => {
    const item = {
      id: 'sm_1',
      signalType: 'posting_time',
      value: 'Tue 08:00',
      reason: 'r',
      weight: 0.7,
      evidenceCount: 4,
      lastEvidenceAt: null,
      updatedAt: '2026-09-27T00:00:00Z',
      pinned: false,
      disabled: false,
    };
    const api = mockFetch((req) =>
      req.method === 'PATCH' ? ok({ memory: item }) : ok({ data: [item] }),
    );
    const user = userEvent.setup();
    renderScreen(<StyleMemoryPanel businessId="biz_1" />);
    await user.click(await screen.findByRole('button', { name: 'Edit Best time to post' }));
    const input = screen.getByLabelText('New value for Best time to post');
    await user.clear(input);
    await user.type(input, 'Fri 07:00');
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await user.click(screen.getByRole('button', { name: 'Pin Best time to post' }));
    await user.click(screen.getByRole('switch', { name: 'Use Best time to post in scripts' }));
    await waitFor(() =>
      expect(api.find('PATCH', '/businesses/biz_1/style-memory/sm_1')).toHaveLength(3),
    );
    expect(api.find('PATCH', '/businesses/biz_1/style-memory/sm_1').map((r) => r.body)).toEqual([
      { value: 'Fri 07:00' },
      { pinned: true },
      { disabled: true },
    ]);
  });
});
