// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeProject, mockFetch, renderWithSWR, type MockRoute } from '../review/test-helpers';
import { SlideshowBuilder, slideSummary } from './slideshow-builder';
import { TemplatePicker } from './template-picker';
import type { Slide } from './types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const slide = (over: Partial<Slide>): Slide => ({
  id: 's1',
  projectId: 'proj_1',
  sortOrder: 0,
  slideType: 'TEXT_CARD',
  imageAssetId: null,
  videoAssetId: null,
  backgroundColor: '#111111',
  durationSec: 2.5,
  transitionIn: null,
  transitionOut: null,
  content: { role: 'hook', text: 'Five cafe tips' },
  problem: null,
  ...over,
});

const slides = [
  slide({}),
  slide({
    id: 's2',
    sortOrder: 1,
    slideType: 'IMAGE_STILL',
    content: { pendingText: true },
    problem: 'needs an image',
  }),
  slide({
    id: 's3',
    sortOrder: 2,
    slideType: 'QUOTE',
    content: { quote: 'Best latte', author: 'Sam' },
  }),
];

const project = makeProject({ sourceType: 'SLIDESHOW', state: 'DRAFT', renders: [] });

function routes(extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { match: '/projects/proj_1/slides', body: { ok: true, data: slides } },
    {
      match: '/image-library',
      body: {
        ok: true,
        data: [{ id: 'img_1', previewUrl: 'https://cdn.test/1.jpg', altText: 'Latte' }],
      },
    },
  ];
}

describe('SlideshowBuilder', () => {
  it('lists slides with what each still needs', async () => {
    mockFetch(routes());
    renderWithSWR(<SlideshowBuilder project={project} businessId="biz_1" onChanged={vi.fn()} />);
    expect(screen.getByLabelText('Loading slides')).toBeInTheDocument();
    expect(await screen.findByText('Five cafe tips')).toBeInTheDocument();
    expect(screen.getByText('needs an image')).toBeInTheDocument();
    expect(screen.getByText(/1 needs attention/)).toBeInTheDocument();
    expect(screen.getByText('Best latte')).toBeInTheDocument();
  });

  it('reorders a slide and uses the returned order', async () => {
    const reordered = [slides[1], slides[0], slides[2]].map((s, i) => ({ ...s!, sortOrder: i }));
    const api = mockFetch(
      routes([
        { method: 'POST', match: '/slides/s2/reorder', body: { ok: true, data: reordered } },
      ]),
    );
    renderWithSWR(<SlideshowBuilder project={project} businessId="biz_1" onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Move slide 2 up' }));
    await waitFor(() =>
      expect(api.find('POST', '/slides/s2/reorder')[0]?.body).toEqual({ newSortOrder: 0 }),
    );
    await waitFor(() => {
      const items = screen.getAllByRole('listitem');
      expect(
        within(items[0]!).getByText('Text to be written by auto-populate'),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Move slide 1 up' })).toBeDisabled();
  });

  it('deletes and adds slides', async () => {
    const api = mockFetch(
      routes([
        { method: 'DELETE', match: '/slides/s3', body: { ok: true, deleted: true } },
        {
          method: 'POST',
          match: '/projects/proj_1/slides',
          status: 201,
          body: { ok: true, slide: slide({ id: 's4', slideType: 'STATISTIC', content: {} }) },
        },
      ]),
    );
    renderWithSWR(<SlideshowBuilder project={project} businessId="biz_1" onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete slide 3' }));
    await waitFor(() => expect(api.find('DELETE', '/slides/s3')).toHaveLength(1));
    await userEvent.selectOptions(screen.getByLabelText('Add a slide'), 'STATISTIC');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() =>
      expect(api.find('POST', '/projects/proj_1/slides')[0]?.body).toEqual({
        slideType: 'STATISTIC',
      }),
    );
  });

  it('edits a slide and sends only what changed', async () => {
    const api = mockFetch(
      routes([{ method: 'PATCH', match: '/slides/s2', body: { ok: true, slide: slides[1] } }]),
    );
    renderWithSWR(<SlideshowBuilder project={project} businessId="biz_1" onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /Text to be written/ }));
    await userEvent.type(screen.getByLabelText('Text'), 'Order ahead');
    await userEvent.click(await screen.findByRole('radio', { name: 'Latte' }));
    const seconds = screen.getByLabelText('Seconds');
    await userEvent.clear(seconds);
    await userEvent.type(seconds, '4');
    await userEvent.click(screen.getByRole('button', { name: /Save slide/ }));
    await waitFor(() =>
      expect(api.find('PATCH', '/slides/s2')[0]?.body).toEqual({
        durationSec: 4,
        imageAssetId: 'img_1',
        content: { text: 'Order ahead' },
      }),
    );
  });

  it('starts auto-populate and saves as a template', async () => {
    const onChanged = vi.fn();
    const api = mockFetch(
      routes([
        {
          method: 'POST',
          match: '/projects/proj_1/auto-populate',
          status: 202,
          body: { ok: true },
        },
        { method: 'POST', match: '/slideshow-templates', status: 201, body: { ok: true } },
      ]),
    );
    renderWithSWR(<SlideshowBuilder project={project} businessId="biz_1" onChanged={onChanged} />);
    await userEvent.click(await screen.findByRole('button', { name: /Auto-populate/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.find('POST', '/projects/proj_1/auto-populate')).toHaveLength(1);
    await userEvent.type(screen.getByLabelText('Save as template'), 'Tips format');
    await userEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() =>
      expect(api.find('POST', '/slideshow-templates')[0]?.body).toEqual({
        projectId: 'proj_1',
        name: 'Tips format',
      }),
    );
  });

  it('is read-only while auto-populate runs', async () => {
    mockFetch(routes());
    renderWithSWR(
      <SlideshowBuilder
        project={{ ...project, state: 'SCANNING' }}
        businessId="biz_1"
        onChanged={vi.fn()}
      />,
    );
    expect(await screen.findByRole('button', { name: /Auto-populating/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete slide 1' })).toBeDisabled();
    expect(screen.queryByLabelText('Add a slide')).not.toBeInTheDocument();
  });

  it('shows an error state', async () => {
    mockFetch([
      {
        match: '/projects/proj_1/slides',
        status: 409,
        body: { ok: false, error: 'conflict', message: 'This project is not a slideshow' },
      },
    ]);
    renderWithSWR(<SlideshowBuilder project={project} businessId="biz_1" onChanged={vi.fn()} />);
    expect(await screen.findByText('This project is not a slideshow')).toBeInTheDocument();
  });

  it('summarises slides by type', () => {
    expect(slideSummary(slide({ content: { value: '3x', label: 'faster' } }))).toEqual({
      text: '3x faster',
    });
    expect(slideSummary(slide({ content: {} }))).toEqual({ key: 'noText' });
  });
});

describe('TemplatePicker', () => {
  it('lists built-in and own templates and reports the choice', async () => {
    const onChange = vi.fn();
    mockFetch([
      {
        match: '/slideshow-templates',
        body: {
          ok: true,
          data: [
            {
              id: 't1',
              organisationId: null,
              name: 'Photo dump',
              category: 'photo_dump',
              slidePlan: [{}, {}],
              musicMood: null,
              defaultDurationPerSlide: 2,
            },
            {
              id: 't2',
              organisationId: 'org_1',
              name: 'Ours',
              category: 'custom',
              slidePlan: null,
              musicMood: null,
              defaultDurationPerSlide: 2,
            },
          ],
        },
      },
    ]);
    renderWithSWR(<TemplatePicker value="t2" onChange={onChange} />);
    expect(await screen.findByText(/Photo dump · 2 slides/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Ours/ })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('radio', { name: /Photo dump/ }));
    expect(onChange).toHaveBeenCalledWith('t1');
  });

  it('has an empty state', async () => {
    mockFetch([{ match: '/slideshow-templates', body: { ok: true, data: [] } }]);
    renderWithSWR(<TemplatePicker value={null} onChange={vi.fn()} />);
    expect(await screen.findByText('No slideshow templates are available.')).toBeInTheDocument();
  });
});
