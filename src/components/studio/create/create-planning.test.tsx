// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR, type MockRoute } from '../review/test-helpers';
import {
  buildCreateBody,
  buildGenerateBody,
  tiersAtOrBelow,
  validateCreate,
  type CreateState,
} from './body';
import { CreateScreen } from './create-screen';
import { defaultSourceFor } from './create-planning-options';

// Phase 15 Track C — Create inputs: language(s) (15.C5), tier override, schedule and approval
// workflow (15.C4), and the Basic plan's Slideshow default (P5).

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/new' }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function routes(planTier: string): MockRoute[] {
  return [
    { match: '/brand-kits', body: { ok: true, data: [] } },
    { match: '/platform-connections', body: { ok: true, data: [] } },
    { match: '/usage', body: { ok: true, usage: { planTier } } },
    {
      match: '/approval-workflows',
      body: { ok: true, data: [{ id: 'wf_1', name: 'Client sign-off' }] },
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

beforeEach(() => push.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe('Create — planning options', () => {
  it('P5: a Basic plan starts on Slideshow; the user can switch back', async () => {
    mockFetch(routes('BASIC'));
    renderWithSWR(<CreateScreen initialReference={null} />);
    expect(await screen.findByLabelText('What’s the slideshow about?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Options/ }));
    await userEvent.click(screen.getByRole('radio', { name: /Video/ }));
    expect(screen.getByLabelText('What’s the video about?')).toBeInTheDocument();
  });

  it('sends the language, extra languages, workflow and a lower tier', async () => {
    const api = mockFetch(routes('PLUS'));
    renderWithSWR(<CreateScreen initialReference={null} />);
    await userEvent.type(await screen.findByLabelText('What’s the video about?'), 'Launch');
    await userEvent.click(screen.getByRole('button', { name: /Options/ }));
    await userEvent.selectOptions(screen.getByLabelText('Language'), 'fr');
    await userEvent.click(screen.getByLabelText('العربية'));
    await userEvent.click(screen.getByRole('button', { name: 'Advanced options' }));
    await waitFor(() => expect(screen.getByLabelText('Quality tier')).not.toBeDisabled());
    // never above the plan
    expect(screen.queryByRole('option', { name: 'Enterprise' })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Quality tier'), 'STANDARD');
    await waitFor(() => expect(screen.getByLabelText('Approval workflow')).not.toBeDisabled());
    await userEvent.selectOptions(screen.getByLabelText('Approval workflow'), 'wf_1');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/p9'));
    expect(api.find('POST', '/projects')[0]?.body).toMatchObject({
      language: 'fr',
      languages: ['ar'],
      approvalWorkflowId: 'wf_1',
    });
    expect(api.find('POST', '/projects/p9/generate')[0]?.body).toEqual({ qualityTier: 'STANDARD' });
  });
});

describe('create body helpers', () => {
  const base: CreateState = {
    brief: 'Launch',
    source: 'BRIEF',
    platforms: ['tiktok'],
    length: 'short',
    brandKitId: null,
    templateId: null,
    targetAudience: '',
    callToAction: '',
    budgetPounds: '',
    reviewPolicy: '',
    projectTemplate: null,
    autoPublish: false,
    autoPublishAccounts: {},
  };

  it('schedules only in the future and with accounts to publish to', () => {
    const now = Date.parse('2026-10-01T10:00:00Z');
    expect(validateCreate({ ...base, scheduleAt: '2026-09-30T10:00' }, 'biz', now)).toContain(
      'Schedule a time in the future.',
    );
    expect(validateCreate({ ...base, scheduleAt: '2026-10-05T10:00' }, 'biz', now)).toContain(
      'Choose the accounts to publish to (auto-publish) for a scheduled video.',
    );
    const scheduled = buildCreateBody(
      {
        ...base,
        scheduleAt: '2026-10-05T10:00',
        autoPublish: true,
        autoPublishAccounts: { tiktok: 'pc_1' },
      },
      'biz',
      null,
    );
    expect(scheduled.publishPolicy).toBe('SCHEDULED');
    expect(scheduled.scheduledStartAt).toBe(new Date('2026-10-05T10:00').toISOString());
  });

  it('never sends the primary language as an extra; generate body only carries a chosen tier', () => {
    expect(
      buildCreateBody({ ...base, language: 'es', extraLanguages: ['es'] }, 'b', null),
    ).not.toHaveProperty('languages');
    expect(buildGenerateBody(base)).toEqual({});
    expect(tiersAtOrBelow('STANDARD')).toEqual(['BASIC', 'STANDARD']);
    expect(defaultSourceFor('BASIC')).toBe('SLIDESHOW');
    expect(defaultSourceFor('PLUS')).toBe('BRIEF');
    expect(defaultSourceFor(undefined)).toBe('BRIEF');
  });
});
