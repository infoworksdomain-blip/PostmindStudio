// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../test/i18n-wrapper';
import { ALL_MESSAGES } from '@/lib/i18n/all-messages';
import type { Locale } from '@/lib/i18n/locales';
import type { Project, Publication } from '@/lib/client/types';
import { BusinessScreen } from './business/business-screen';
import { PublicationsCalendar } from './calendar/publications-calendar';
import { ConnectionsScreen } from './connections/connections-screen';
import { ProjectsList } from './projects/projects-list';
import { mockFetch, ok, renderScreen } from './publications/test-utils';
import { PublicationsList } from './publications/publications-list';

// BACKLOG 16.4 — the Manage screens (projects, publications, calendar, business, connections)
// render from the ar (RTL) and zh-Hans catalogues. Expected text comes from the catalogues, so a
// key left in English or missing fails here (missing keys throw in the test provider).

vi.mock('next/navigation', () => ({
  usePathname: () => '/connections',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => vi.unstubAllGlobals());

const LOCALES: Locale[] = ['ar', 'zh-Hans'];

const project = {
  id: 'prj_1',
  name: 'Autumn launch',
  state: 'READY_FOR_REVIEW',
  sourceType: 'PROMPT',
  targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 30 }],
  costActualPence: 1234,
  updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
} as unknown as Project;

function publication(overrides: Partial<Publication> = {}): Publication {
  return {
    id: 'pub_1',
    projectId: 'prj_1',
    renderId: 'ren_1',
    platform: 'youtube_short',
    platformAccountId: 'acc',
    state: 'SCHEDULED',
    scheduledFor: new Date(2026, 8, 14, 10, 30).toISOString(),
    publishedAt: null,
    platformPostId: null,
    platformUrl: null,
    caption: null,
    hashtags: [],
    errorReason: null,
    errorCode: null,
    retryCount: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    project: { id: 'prj_1', name: 'Autumn launch' },
    ...overrides,
  };
}

describe.each(LOCALES)('Manage screens in %s', (locale) => {
  const m = ALL_MESSAGES[locale];

  it('renders the projects list', async () => {
    mockFetch(() => ok({ data: [project], nextCursor: null }));
    renderScreen(withLocale(locale, <ProjectsList />));
    expect(await screen.findByText('Autumn launch')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(m.projects.list.title);
    const tabs = screen.getByRole('radiogroup', { name: m.projects.list.filtersAria });
    expect(within(tabs).getByRole('radio', { name: m.projects.list.filters.review })).toBeVisible();
    expect(screen.getAllByText(m.format.projectState.READY_FOR_REVIEW).length).toBeGreaterThan(0);
    expect(document.documentElement).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
  });

  it('renders the publications list', async () => {
    mockFetch(() => ok({ data: [publication()], nextCursor: null }));
    renderScreen(withLocale(locale, <PublicationsList />));
    expect(await screen.findByText('Autumn launch')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(m.publications.list.title);
    expect(
      screen.getByRole('columnheader', { name: m.publications.list.columns.views }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(m.format.publicationState.SCHEDULED).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: m.publications.actions.cancel })).toBeVisible();
  });

  it('renders the calendar month with localised weekdays', async () => {
    mockFetch((req) =>
      req.url.pathname.endsWith('/drip-queue')
        ? ok({ dripQueue: null })
        : ok({ data: [publication()], nextCursor: null }),
    );
    renderScreen(withLocale(locale, <PublicationsCalendar initialDate={new Date(2026, 8, 10)} />));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(m.calendar.title);
    const month = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
      new Date(2026, 8, 1),
    );
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(month);
    expect(screen.getByRole('button', { name: m.calendar.nextMonth })).toBeInTheDocument();
    const monday = new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(
      new Date(2026, 8, 7, 12),
    );
    expect((await screen.findAllByText(monday)).length).toBeGreaterThan(0);
    // 25.9: the drip queue moved into the "Posting times" sheet, opened from the header.
    expect(
      await screen.findByRole('button', { name: m.calendar.postingTimes.open }),
    ).toBeInTheDocument();
  });

  it('renders the business screen tabs and profile', async () => {
    mockFetch(() =>
      ok({
        profile: {
          id: 'bp_1',
          businessId: 'biz_1',
          industry: 'Food',
          subNiche: 'Bakery',
          products: ['bread'],
          services: [],
          audienceKeywords: [],
          toneIndicators: [],
          regions: [],
          imageThemes: [],
          imageSearchQueries: ['bakery'],
          restrictedTopics: [],
          brandVoiceSummary: null,
          classifierModel: 'claude-sonnet',
          lastRefreshedAt: '2026-09-20T10:00:00.000Z',
          editedByUser: false,
        },
      }),
    );
    renderScreen(withLocale(locale, <BusinessScreen />));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(m.business.screen.title);
    expect(screen.getByRole('tab', { name: m.business.screen.tabs.learned })).toBeInTheDocument();
    expect(await screen.findByText(m.business.profile.eyebrow)).toBeInTheDocument();
    expect(screen.getByLabelText(m.business.profile.fields.products.label)).toBeInTheDocument();
  });

  it('renders the connections screen', async () => {
    mockFetch((req) =>
      req.url.pathname.endsWith('/platform-connections')
        ? ok({ data: [] })
        : ok({ data: [], keys: [] }),
    );
    renderScreen(withLocale(locale, <ConnectionsScreen navigate={vi.fn()} />));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(m.connections.title);
    expect(await screen.findByText(m.connections.posts.tiktok)).toBeInTheDocument();
    expect(screen.getAllByText(m.connections.notConnected).length).toBeGreaterThan(0);
    expect(screen.getAllByText(m.connections.meta.guidance)).toHaveLength(2);
  });
});
