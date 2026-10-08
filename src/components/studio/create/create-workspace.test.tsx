// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR, type MockRoute } from '../review/test-helpers';
import { CreateScreen } from './create-screen';
import { actionBar, openMoreOptions, pickFormat } from './create-test-helpers';
import type { VideoModelView } from './generate-body';

// BACKLOG 25.7 / 25.8 — the Create workspace: the format rail first, the Basic plan's visible
// Slideshow default, the live allowance line, and the video model choice sent as
// preferredProviders.AI_CLIP (Automatic sends nothing).

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/new' }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const model = (providerId: string, displayName: string, tiers: string[]): VideoModelView => ({
  providerId,
  displayName,
  capabilities: ['text_to_video', 'image_to_video'],
  maxClipSec: 10,
  aspectRatios: ['9:16', '16:9'],
  audio: false,
  typicalLatencySec: 120,
  tiers: tiers as VideoModelView['tiers'],
});

const meter = (usedQuarters: number, limitQuarters: number) => ({
  used: usedQuarters / 4,
  limit: limitQuarters / 4,
  percent: 0,
  maxDurationSec: 60,
  usedQuarters,
  limitQuarters,
});

function routes(planTier: string, extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { match: '/brand-kits', body: { ok: true, data: [] } },
    { match: '/platform-connections', body: { ok: true, data: [] } },
    {
      match: '/usage',
      body: {
        ok: true,
        usage: {
          planTier,
          period: 'month',
          videos: { short: meter(78, 96), long: meter(0, 8) },
        },
      },
    },
    {
      match: '/video-models',
      body: {
        ok: true,
        planTier,
        models: [
          model('seedance', 'Seedance 2.0', ['BASIC', 'STANDARD']),
          model('runway', 'Runway Gen-4.5', ['STANDARD']),
        ].filter((m) => m.tiers.includes(planTier as VideoModelView['tiers'][number])),
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
});
afterEach(() => vi.unstubAllGlobals());

const openModels = async () =>
  userEvent.click(await screen.findByRole('button', { name: 'Change model' }));

async function generate(brief = 'Spring menu launch') {
  await userEvent.type(await screen.findByLabelText('What’s the video about?'), brief);
  await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
  await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/p9'));
}

describe('Create workspace (25.7)', { timeout: 60_000 }, () => {
  it('puts the format rail first, before the brief', () => {
    mockFetch(routes('STANDARD'));
    renderWithSWR(<CreateScreen initialReference={null} />);
    const rail = screen.getByRole('radiogroup', { name: 'What to make' });
    const brief = screen.getByLabelText('What’s the video about?');
    expect(rail.compareDocumentPosition(brief) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'AI video' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'More options' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('shows why a Basic plan starts on Slideshow, until a format is picked', async () => {
    mockFetch(routes('BASIC'));
    renderWithSWR(<CreateScreen initialReference={null} />);
    expect(await screen.findByRole('radio', { name: 'Slideshow' })).toBeChecked();
    expect(screen.getByRole('radiogroup', { name: 'What to make' })).toHaveAccessibleDescription(
      /Your plan starts on Slideshow, which uses ¼ of a video/,
    );
    await pickFormat('AI video');
    expect(screen.queryByText(/Your plan starts on Slideshow/)).not.toBeInTheDocument();
  });

  it('shows what each format uses of the allowance and what is left', async () => {
    mockFetch(routes('STANDARD'));
    renderWithSWR(<CreateScreen initialReference={null} />);
    await waitFor(() =>
      expect(within(actionBar()).getByTestId('create-allowance')).toHaveTextContent(
        'Uses 1 of your videos · 4.5 of 24 left this month',
      ),
    );
    await pickFormat('Carousel');
    expect(within(actionBar()).getByTestId('create-allowance')).toHaveTextContent(
      'Uses ¼ of a video',
    );
    await pickFormat('Creator video (UGC)');
    expect(within(actionBar()).getByTestId('create-allowance')).toHaveTextContent(
      'Uses 2 of your videos',
    );
  });

  it('keeps Ctrl/⌘ + Enter in the brief as a way to submit', async () => {
    const api = mockFetch(routes('STANDARD'));
    renderWithSWR(<CreateScreen initialReference={null} />);
    await userEvent.type(
      screen.getByLabelText('What’s the video about?'),
      'Launch{Control>}{Enter}{/Control}',
    );
    await waitFor(() => expect(api.find('POST', '/projects')).toHaveLength(1));
  });

  it('says “Making your video…” once generation has started', async () => {
    mockFetch(routes('STANDARD'));
    renderWithSWR(<CreateScreen initialReference={null} />);
    await generate();
    expect(toast.success).toHaveBeenCalledWith('Making your video…');
  });
});

describe('Video model on Create (25.8)', { timeout: 60_000 }, () => {
  it('Automatic is the default and sends no preference', async () => {
    const api = mockFetch(routes('STANDARD'));
    renderWithSWR(<CreateScreen initialReference={null} />);
    expect(await screen.findByTestId('video-model-current')).toHaveTextContent(
      'Automatic (recommended)',
    );
    await openModels();
    expect(screen.getByRole('radio', { name: 'Automatic (recommended)' })).toBeChecked();
    await generate();
    expect(api.find('POST', '/projects/p9/generate')[0]?.body).toEqual({});
  });

  it('lists only the models of the plan and sends the chosen one for AI clips', async () => {
    const api = mockFetch(routes('STANDARD'));
    renderWithSWR(<CreateScreen initialReference={null} />);
    await openModels();
    const group = await screen.findByRole('radiogroup', { name: 'Video model' });
    await within(group).findByRole('radio', { name: 'Runway Gen-4.5' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    await userEvent.click(within(group).getByRole('radio', { name: 'Runway Gen-4.5' }));
    await generate();
    expect(api.find('POST', '/projects/p9/generate')[0]?.body).toEqual({
      preferredProviders: { AI_CLIP: ['runway'] },
    });
  });

  it('drops a model the chosen lower tier cannot use and says Automatic applies', async () => {
    const api = mockFetch(routes('STANDARD'));
    renderWithSWR(<CreateScreen initialReference={null} />);
    await openModels();
    await userEvent.click(await screen.findByRole('radio', { name: 'Runway Gen-4.5' }));
    await openMoreOptions();
    await userEvent.selectOptions(screen.getByLabelText('Quality tier'), 'BASIC');
    expect(screen.queryByRole('radio', { name: 'Runway Gen-4.5' })).not.toBeInTheDocument();
    expect(screen.getByText(/isn’t available at this quality tier/)).toBeInTheDocument();
    await generate();
    expect(api.find('POST', '/projects/p9/generate')[0]?.body).toEqual({ qualityTier: 'BASIC' });
  });

  it('is not offered for formats that make no AI clips', async () => {
    mockFetch(routes('STANDARD'));
    renderWithSWR(<CreateScreen initialReference={null} />);
    await screen.findByRole('button', { name: 'Change model' });
    for (const format of ['Slideshow', 'Carousel', 'Your video', 'Wall of text']) {
      await pickFormat(format);
      expect(screen.queryByRole('button', { name: 'Change model' })).not.toBeInTheDocument();
    }
    await pickFormat('Hook + demo');
    expect(screen.getByRole('button', { name: 'Change model' })).toBeInTheDocument();
  });

  it('shows no control at all when no model is available', async () => {
    mockFetch(routes('ENTERPRISE'));
    renderWithSWR(<CreateScreen initialReference={null} />);
    await screen.findByLabelText('What’s the video about?');
    await waitFor(() => expect(screen.getByTestId('create-allowance')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Change model' })).not.toBeInTheDocument();
  });
});
