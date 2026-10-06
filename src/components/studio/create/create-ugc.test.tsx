// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR, type MockRoute } from '../review/test-helpers';
import { buildCreateBody, EMPTY_UGC, ugcBody, validateCreate, type CreateState } from './body';
import { CreateScreen } from './create-screen';

// BACKLOG 21.4 — the "UGC actor" option on Create: the source, the product and actor choices, the
// allowance note ("uses 2 of your videos", never a cost), the body sent to POST /projects and the
// refusal message when the brief asks for a real person.

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/new' }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

function routes(extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { match: '/brand-kits', body: { ok: true, data: [] } },
    { match: '/platform-connections', body: { ok: true, data: [] } },
    {
      match: '/businesses/biz_1/business-profile',
      body: { ok: true, profile: { products: ['Oat latte kit', 'Cold brew'] } },
    },
    {
      match: '/image-library',
      body: {
        ok: true,
        data: [{ id: 'img_1', previewUrl: 'https://cdn.test/p.png', altText: 'Latte kit box' }],
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
  toast.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

async function chooseUgc() {
  await userEvent.click(screen.getByRole('button', { name: /Options/ }));
  await userEvent.click(screen.getByRole('radio', { name: /UGC actor/ }));
}

describe('Create: UGC actor (21.4)', () => {
  it('shows the actor options and the allowance note, never a cost', async () => {
    mockFetch(routes());
    renderWithSWR(<CreateScreen initialReference={null} />);
    await chooseUgc();
    const section = screen.getByRole('region', { name: 'UGC actor' });
    expect(within(section).getByTestId('ugc-allowance')).toHaveTextContent(
      'UGC video · uses 2 of your videos',
    );
    expect(section.textContent).not.toMatch(/£|\$/);
    expect(within(section).getByText(/AI-generated people, never real ones/)).toBeInTheDocument();
    expect(screen.getByLabelText('What should the actor talk about?')).toBeInTheDocument();
  });

  it('sends the brief with the chosen product, photo and look', { timeout: 60_000 }, async () => {
    const api = mockFetch(routes());
    renderWithSWR(<CreateScreen initialReference={null} />);
    await chooseUgc();
    await userEvent.type(screen.getByLabelText('What should the actor talk about?'), 'Latte kit');
    await userEvent.type(screen.getByLabelText('Product (optional)'), 'Oat kit');
    await userEvent.click(await screen.findByRole('radio', { name: 'Latte kit box' }));
    await userEvent.selectOptions(screen.getByLabelText('Age'), '25-34');
    await userEvent.selectOptions(screen.getByLabelText('Person'), 'woman');
    await userEvent.selectOptions(screen.getByLabelText('Setting'), 'kitchen');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/p9'));
    const [create] = api.find('POST', '/projects');
    expect(create?.body).toMatchObject({
      sourceType: 'BRIEF',
      brief: { rawInput: 'Latte kit' },
      ugc: {
        product: { name: 'Oat kit', imageId: 'img_1' },
        actor: { ageRange: '25-34', gender: 'woman', setting: 'kitchen' },
      },
    });
  });

  it(
    'explains a refused real-person brief instead of a generic error',
    { timeout: 60_000 },
    async () => {
      mockFetch(
        routes([
          {
            method: 'POST',
            match: '/projects',
            status: 400,
            body: {
              ok: false,
              error: 'validation_error',
              message: 'refused',
              details: { reason: 'ugc_real_person_refused' },
            },
          },
        ]),
      );
      renderWithSWR(<CreateScreen initialReference={null} />);
      await chooseUgc();
      await userEvent.type(screen.getByLabelText('What should the actor talk about?'), 'Celebrity');
      await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'UGC actors are generated people. They can’t imitate, look like or sound like a real person or celebrity',
      );
      expect(toast.error).not.toHaveBeenCalled();
    },
  );
});

describe('Create: UGC creator picker (22.3)', () => {
  const creator = (over: Record<string, unknown>) => ({
    businessId: 'biz_1',
    gender: 'woman',
    ageRange: '25-34',
    setting: 'kitchen',
    appearance: null,
    voiceTone: null,
    status: 'READY',
    isDefault: false,
    lastUsedAt: null,
    portraitError: null,
    portraitSource: 'GENERATED',
    portraitUrl: 'https://cdn.test/face.png',
    createdAt: '2026-10-01T00:00:00Z',
    retiredAt: null,
    ...over,
  });
  const creators: MockRoute = {
    match: '/businesses/biz_1/creators',
    body: {
      ok: true,
      data: [
        creator({ id: 'cr_maya', name: 'Maya', useCount: 5 }),
        creator({ id: 'cr_tom', name: 'Tom', useCount: 1, gender: 'man' }),
        creator({ id: 'cr_draft', name: 'Draft', useCount: 0, status: 'DRAFT', portraitUrl: null }),
      ],
    },
  };

  it(
    'defaults to the most used creator, hides the one-off look and sends its id',
    { timeout: 60_000 },
    async () => {
      const api = mockFetch(routes([creators]));
      renderWithSWR(<CreateScreen initialReference={null} />);
      await chooseUgc();
      const picker = await screen.findByLabelText('Creator');
      await waitFor(() => expect(picker).toHaveValue('cr_maya'));
      // READY creators and the one-off actor are offered; a creator with no portrait is not.
      expect(
        within(picker)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Maya', 'Tom', 'New one-off actor']);
      expect(screen.getByRole('img', { name: 'Portrait of Maya' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Age')).not.toBeInTheDocument();
      await userEvent.selectOptions(picker, 'cr_tom');
      await userEvent.type(screen.getByLabelText('What should the actor talk about?'), 'Latte kit');
      await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
      await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/p9'));
      const [create] = api.find('POST', '/projects');
      expect((create?.body as { ugc: unknown }).ugc).toEqual({ creatorId: 'cr_tom' });
    },
  );

  it(
    '"New one-off actor" brings back the look presets (today’s behaviour)',
    { timeout: 60_000 },
    async () => {
      const api = mockFetch(routes([creators]));
      renderWithSWR(<CreateScreen initialReference={null} />);
      await chooseUgc();
      const picker = await screen.findByLabelText('Creator');
      await waitFor(() => expect(picker).toHaveValue('cr_maya'));
      await userEvent.selectOptions(picker, 'one-off');
      await userEvent.selectOptions(screen.getByLabelText('Person'), 'man');
      await userEvent.type(screen.getByLabelText('What should the actor talk about?'), 'Kit');
      await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
      await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/p9'));
      const [create] = api.find('POST', '/projects');
      expect((create?.body as { ugc: unknown }).ugc).toEqual({ actor: { gender: 'man' } });
    },
  );

  it('a creator replaces the actor look in the body', () => {
    expect(ugcBody({ ...EMPTY_UGC, gender: 'man', productName: 'Kit', creatorId: 'cr_1' })).toEqual(
      {
        product: { name: 'Kit' },
        creatorId: 'cr_1',
      },
    );
    expect(ugcBody({ ...EMPTY_UGC, creatorId: null })).toEqual({});
  });
});

describe('UGC body and validation', () => {
  const base: CreateState = {
    brief: 'Review our kit',
    source: 'UGC',
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
    ugc: EMPTY_UGC,
  };

  it('sends only what the owner chose', () => {
    expect(ugcBody(EMPTY_UGC)).toEqual({});
    expect(ugcBody({ ...EMPTY_UGC, productName: '  Kit  ', gender: 'man' })).toEqual({
      product: { name: 'Kit' },
      actor: { gender: 'man' },
    });
    expect(buildCreateBody(base, 'biz', null)).toMatchObject({ sourceType: 'BRIEF', ugc: {} });
  });

  it('a UGC video is English and short', () => {
    expect(validateCreate(base, 'biz')).toEqual([]);
    expect(validateCreate({ ...base, language: 'fr' }, 'biz')).toContain('ugcEnglishOnly');
    expect(validateCreate({ ...base, extraLanguages: ['de'] }, 'biz')).toContain('ugcEnglishOnly');
    expect(validateCreate({ ...base, length: 'long' }, 'biz')).toContain('ugcShortOnly');
    expect(validateCreate({ ...base, brief: '' }, 'biz')).toContain('briefRequired');
  });
});
