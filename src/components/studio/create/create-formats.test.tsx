// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR, type MockRoute } from '../review/test-helpers';
import { HOOK_LINE_MAX_WORDS as SERVER_HOOK_WORDS } from '@/lib/studio/formats/hook-demo';
import {
  WALL_TEXT_MAX_CHARS as SERVER_WALL_CHARS,
  WALL_TEXT_MAX_LINES as SERVER_WALL_LINES,
  WALL_TEXT_MAX_WORDS as SERVER_WALL_WORDS,
} from '@/lib/studio/formats/copy-prompt';
import { WALL_DEFAULT_SEC, WALL_MAX_SEC, WALL_MIN_SEC } from '@/lib/studio/formats/wall-of-text';
import {
  buildCreateBody,
  EMPTY_HOOK_DEMO,
  EMPTY_WALL_OF_TEXT,
  HOOK_LINE_MAX_WORDS,
  validateCreate,
  WALL_SECONDS,
  WALL_TEXT_MAX_CHARS,
  WALL_TEXT_MAX_LINES,
  WALL_TEXT_MAX_WORDS,
  type CreateState,
} from './body';

const SERVER_WALL = {
  words: SERVER_WALL_WORDS,
  lines: SERVER_WALL_LINES,
  chars: SERVER_WALL_CHARS,
};
import { CreateScreen } from './create-screen';

// 22.1 / 22.2: Create → "Hook + demo" and "Wall of text".

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/new' }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

function routes(demos: Array<{ id: string; fileName: string; durationSec: number }>): MockRoute[] {
  return [
    { match: '/brand-kits', body: { ok: true, data: [] } },
    { match: '/platform-connections', body: { ok: true, data: [] } },
    { match: '/uploads/demo-videos', body: { ok: true, data: demos } },
    { method: 'POST', match: '/projects', status: 201, body: { ok: true, project: { id: 'h1' } } },
    {
      method: 'POST',
      match: '/projects/h1/generate',
      status: 202,
      body: { ok: true, projectId: 'h1', state: 'QUEUED' },
    },
  ];
}

beforeEach(() => {
  push.mockReset();
  toast.success.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

async function choose(name: string) {
  await userEvent.click(screen.getByRole('button', { name: /Options/ }));
  await userEvent.click(screen.getByRole('radio', { name }));
}

describe('Create → Hook + demo', () => {
  it('uses the newest demo, the owner’s hook line and layout, and starts generating', async () => {
    const api = mockFetch(
      routes([
        { id: 'demo-new', fileName: 'booking-app.mp4', durationSec: 42 },
        { id: 'demo-old', fileName: 'older.mp4', durationSec: 20 },
      ]),
    );
    renderWithSWR(<CreateScreen initialReference={null} />);
    await choose('Hook + demo');
    expect(screen.getByText('What does your demo show?')).toBeInTheDocument();
    const demo = await screen.findByRole('radio', { name: /booking-app\.mp4/ });
    await waitFor(() => expect(demo).toHaveAttribute('aria-checked', 'true'));
    await userEvent.type(screen.getByLabelText('Hook line (optional)'), 'Bookings in two taps');
    await userEvent.selectOptions(screen.getByLabelText('Layout'), 'stacked');
    // A fixed-length format: no Short / Long choice.
    expect(screen.queryByRole('radiogroup', { name: /length/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/h1'));
    const body = api.find('POST', '/projects')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      name: 'Bookings in two taps',
      sourceType: 'HOOK_DEMO',
      hookDemo: {
        demoUploadId: 'demo-new',
        hookLine: 'Bookings in two taps',
        hookSource: 'ai_creator',
        reaction: 'surprised',
        layout: 'stacked',
        audioMix: 'balanced',
      },
    });
    expect(body.brief).toBeUndefined();
    expect(toast.success).toHaveBeenCalledWith(
      'Generating — Studio is writing the text and making your video.',
    );
  });

  it('with no demo videos it says to upload one and does not submit', async () => {
    const api = mockFetch(routes([]));
    renderWithSWR(<CreateScreen initialReference={null} />);
    await choose('Hook + demo');
    expect(await screen.findByTestId('hook-demo-empty')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Upload a demo video of your product');
    expect(api.find('POST', '/projects')).toHaveLength(0);
  });

  it('shows the no_demo_video refusal beside the form', async () => {
    const api = mockFetch([
      ...routes([{ id: 'demo-1', fileName: 'demo.mp4', durationSec: 30 }]).filter(
        (r) => r.method !== 'POST',
      ),
      {
        method: 'POST',
        match: '/projects',
        status: 422,
        body: { ok: false, error: 'no_demo_video', message: 'Upload a demo video first' },
      },
    ]);
    renderWithSWR(<CreateScreen initialReference={null} />);
    await choose('Hook + demo');
    await screen.findByRole('radio', { name: /demo\.mp4/ });
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Upload a demo video of your product'),
    );
    expect(api.find('POST', '/projects')).toHaveLength(1);
    expect(push).not.toHaveBeenCalled();
  });
});

describe('Create → Wall of text', () => {
  it('sends the owner’s block, background and length', async () => {
    const api = mockFetch(routes([]));
    renderWithSWR(<CreateScreen initialReference={null} />);
    await choose('Wall of text');
    await userEvent.type(
      screen.getByLabelText('Text (optional)'),
      'Three habits{enter}- Plan{enter}- Rest',
    );
    await userEvent.selectOptions(screen.getByLabelText('Background'), 'nature');
    await userEvent.selectOptions(screen.getByLabelText('Length'), '10');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(api.find('POST', '/projects')).toHaveLength(1));
    expect(api.find('POST', '/projects')[0]?.body).toMatchObject({
      sourceType: 'WALL_OF_TEXT',
      wallOfText: { text: 'Three habits\n- Plan\n- Rest', background: 'nature', durationSec: 10 },
    });
  });

  it('asks for a description or a text block', async () => {
    const api = mockFetch(routes([]));
    renderWithSWR(<CreateScreen initialReference={null} />);
    await choose('Wall of text');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Describe the video or write the text yourself.',
    );
    expect(api.find('POST', '/projects')).toHaveLength(0);
  });
});

describe('Create mirrors the server limits (22.1 / 22.2)', () => {
  it('uses the same word, line, character and length limits as the API', () => {
    expect(HOOK_LINE_MAX_WORDS).toBe(SERVER_HOOK_WORDS);
    expect(WALL_TEXT_MAX_WORDS).toBe(SERVER_WALL.words);
    expect(WALL_TEXT_MAX_LINES).toBe(SERVER_WALL.lines);
    expect(WALL_TEXT_MAX_CHARS).toBe(SERVER_WALL.chars);
    expect(EMPTY_WALL_OF_TEXT.durationSec).toBe(WALL_DEFAULT_SEC);
    expect(WALL_SECONDS.every((s) => s >= WALL_MIN_SEC && s <= WALL_MAX_SEC)).toBe(true);
  });
});

describe('format create bodies (22.1 / 22.2)', () => {
  const base: CreateState = {
    brief: '',
    source: 'HOOK_DEMO',
    platforms: ['tiktok'],
    length: 'long',
    brandKitId: null,
    templateId: null,
    targetAudience: '',
    callToAction: '',
    budgetPounds: '',
    reviewPolicy: '',
    projectTemplate: null,
    autoPublish: false,
    autoPublishAccounts: {},
    hookDemo: { ...EMPTY_HOOK_DEMO, demoUploadId: 'd1' },
    wallOfText: EMPTY_WALL_OF_TEXT,
  };

  it('a hook + demo body is short-form, with the brief only when given', () => {
    const body = buildCreateBody({ ...base, brief: 'Show the booking flow' }, 'biz_1', null);
    expect(body).toMatchObject({
      sourceType: 'HOOK_DEMO',
      brief: { rawInput: 'Show the booking flow' },
      hookDemo: { demoUploadId: 'd1', hookSource: 'ai_creator', layout: 'sequential' },
    });
    expect(body.hookDemo).not.toHaveProperty('hookLine');
    expect(body.targetFormats?.[0]).toMatchObject({ platform: 'tiktok' });
  });

  it('validates the demo, the hook line and the wall text', () => {
    expect(validateCreate({ ...base, hookDemo: EMPTY_HOOK_DEMO }, 'biz_1')).toEqual([
      'demoRequired',
    ]);
    expect(
      validateCreate(
        {
          ...base,
          hookDemo: { ...EMPTY_HOOK_DEMO, demoUploadId: 'd1', hookLine: 'a '.repeat(13) },
        },
        'biz_1',
      ),
    ).toEqual(['hookLineTooLong']);
    expect(validateCreate(base, 'biz_1')).toEqual([]);
    const wall = { ...base, source: 'WALL_OF_TEXT' as const };
    expect(validateCreate(wall, 'biz_1')).toEqual(['wallTextRequired']);
    expect(
      validateCreate(
        { ...wall, wallOfText: { ...EMPTY_WALL_OF_TEXT, text: 'w '.repeat(61) } },
        'biz_1',
      ),
    ).toEqual(['wallTextTooLong']);
    expect(validateCreate({ ...wall, brief: 'Bread tips' }, 'biz_1')).toEqual([]);
  });
});
