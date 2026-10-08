// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR, type MockRoute } from '../review/test-helpers';
import { buildCreateBody, validateCreate, type CreateState } from './body';
import { CreateScreen } from './create-screen';
import { openMoreOptions } from './create-test-helpers';

// 21.6: Create → Carousel (post cards).

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/new' }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

function routes(): MockRoute[] {
  return [
    { match: '/brand-kits', body: { ok: true, data: [] } },
    { match: '/platform-connections', body: { ok: true, data: [] } },
    { method: 'POST', match: '/projects', status: 201, body: { ok: true, project: { id: 'c9' } } },
    {
      method: 'POST',
      match: '/projects/c9/generate',
      status: 202,
      body: { ok: true, projectId: 'c9', state: 'QUEUED' },
    },
  ];
}

beforeEach(() => {
  push.mockReset();
  toast.success.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

async function chooseCarousel() {
  await openMoreOptions();
  await userEvent.click(screen.getByRole('radio', { name: 'Carousel' }));
}

describe('Create → Carousel', () => {
  it('creates a dark 5-post carousel from the brief and starts writing it', async () => {
    const api = mockFetch(routes());
    renderWithSWR(<CreateScreen initialReference={null} />);
    await chooseCarousel();
    expect(screen.getByText('What’s the carousel about?')).toBeInTheDocument();
    // Video-only choices and £ budgets are not offered for a carousel.
    expect(screen.queryByRole('checkbox', { name: 'TikTok' })).not.toBeInTheDocument();
    expect(screen.queryByText(/budget/i)).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('What’s the carousel about?'), 'Bread storage tips');
    const look = screen.getByRole('radiogroup', { name: 'Look' });
    await userEvent.click(within(look).getByRole('radio', { name: 'Dark' }));
    await userEvent.selectOptions(screen.getByLabelText('Number of posts'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Create carousel' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/c9'));
    const [create] = api.find('POST', '/projects');
    expect(create?.body).toEqual({
      name: 'Bread storage tips',
      businessId: 'biz_1',
      sourceType: 'CAROUSEL',
      carousel: { theme: 'dark', postCount: 5 },
      brief: { rawInput: 'Bread storage tips' },
    });
    expect(api.find('POST', '/projects/c9/generate')).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledWith('Writing your carousel…');
  });

  it('accepts a pasted thread instead of a brief', async () => {
    const api = mockFetch(routes());
    renderWithSWR(<CreateScreen initialReference={null} />);
    await chooseCarousel();
    await userEvent.type(
      screen.getByLabelText('Your thread (optional)'),
      'Hook{enter}---{enter}CTA',
    );
    expect(screen.getByLabelText('Number of posts')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Create carousel' }));
    await waitFor(() => expect(api.find('POST', '/projects')).toHaveLength(1));
    const body = api.find('POST', '/projects')[0]?.body as {
      carousel: { thread: string };
      brief?: unknown;
    };
    expect(body.carousel.thread).toBe('Hook\n---\nCTA');
    expect(body.brief).toBeUndefined();
  });

  it('asks for a brief or a thread', async () => {
    const api = mockFetch(routes());
    renderWithSWR(<CreateScreen initialReference={null} />);
    await chooseCarousel();
    await userEvent.click(screen.getByRole('button', { name: 'Create carousel' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Describe the carousel or paste a thread.');
    expect(api.find('POST', '/projects')).toHaveLength(0);
  });
});

describe('carousel create body', () => {
  const state: CreateState = {
    brief: '',
    source: 'CAROUSEL',
    platforms: [],
    length: 'short',
    brandKitId: 'kit_1',
    templateId: null,
    targetAudience: '',
    callToAction: '',
    budgetPounds: '25',
    reviewPolicy: 'REQUIRE_APPROVAL',
    projectTemplate: null,
    autoPublish: false,
    autoPublishAccounts: {},
    carouselPosts: 40,
    language: 'ar',
  };

  it('clamps the post count, keeps the kit, policy and language, and never sends a budget', () => {
    expect(buildCreateBody({ ...state, brief: 'Tips' }, 'biz_1', null)).toEqual({
      name: 'Tips',
      businessId: 'biz_1',
      sourceType: 'CAROUSEL',
      carousel: { theme: 'light', postCount: 12 },
      brief: { rawInput: 'Tips' },
      brandKitId: 'kit_1',
      reviewPolicy: 'REQUIRE_APPROVAL',
      language: 'ar',
    });
  });

  it('validates only what a carousel needs', () => {
    expect(validateCreate(state, 'biz_1')).toEqual(['carouselBriefRequired']);
    expect(validateCreate({ ...state, carouselThread: 'x'.repeat(8_000) }, null)).toEqual([
      'businessRequired',
      'carouselThreadTooLong',
    ]);
    expect(validateCreate({ ...state, brief: 'ok' }, 'biz_1')).toEqual([]);
  });
});
