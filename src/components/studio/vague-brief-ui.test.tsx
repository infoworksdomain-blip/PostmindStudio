// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/lib/client/types';
import { withLocale } from '../../../test/i18n-wrapper';
import { BriefHint, briefHintDescribedBy } from './brief-hint';
import { FirstVideoStep } from './onboarding/first-video-step';
import { ItemForm } from './plans/plan-editor';
import { ProjectsList } from './projects/projects-list';
import { mockFetch, ok, renderScreen, type RecordedRequest } from './publications/test-utils';

// BACKLOG 20.18 — the gentle hint for short briefs (never blocking) and the "too vague" reason on
// the projects list, linking to the project page's directions panel.

vi.mock('next/navigation', () => ({
  usePathname: () => '/projects',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const HINT =
  'This is quite short. Add who it’s for, what to say, or the feel you want, and we’ll make something better. You can still generate.';

function Field() {
  const [text, setText] = useState('');
  return (
    <>
      <label htmlFor="b">Brief</label>
      <textarea
        id="b"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-describedby={briefHintDescribedBy(text, 'b-hint')}
      />
      <BriefHint text={text} id="b-hint" />
    </>
  );
}

describe('BriefHint', () => {
  it('appears for a short brief, describes the field, and goes once there is detail', async () => {
    render(<Field />);
    const box = screen.getByLabelText('Brief');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await userEvent.type(box, 'space video');
    expect(screen.getByRole('status')).toHaveTextContent(HINT);
    expect(box).toHaveAccessibleDescription(HINT);
    await userEvent.type(box, ' for startup founders about our launch countdown');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(box).not.toHaveAttribute('aria-describedby');
  });

  it('does not penalise Chinese text and is translated', () => {
    const { rerender } = render(<BriefHint text="为我们的咖啡店制作秋季新品宣传视频" id="h" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(withLocale('de', <BriefHint text="Video" id="h" />));
    expect(screen.getByRole('status')).toHaveTextContent('Das ist recht kurz.');
  });

  it('never blocks saving a month-plan post (hint shown, Save still submits)', async () => {
    const onSave = vi.fn(async () => undefined);
    render(
      <ItemForm
        item={{ id: 'i1', title: 'Space', brief: '', kind: 'VIDEO', slides: null }}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByRole('textbox', { name: /brief/i }), 'video');
    expect(screen.getByTestId('brief-hint')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ brief: 'video' }));
  });
});

describe('ProjectsList with a too-vague project', () => {
  const vague = {
    id: 'prj_v',
    name: 'space video',
    state: 'DRAFT',
    sourceType: 'BRIEF',
    errorReason: 'brief_too_vague',
    targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
    costActualPence: 0,
    updatedAt: '2026-10-01T10:00:00.000Z',
    createdAt: '2026-10-01T10:00:00.000Z',
  } as Project;
  const other = { ...vague, id: 'prj_ok', name: 'Bread', errorReason: null } as Project;
  const restricted = {
    ...vague,
    id: 'prj_r',
    name: 'Election offer',
    errorReason: 'restricted_topics',
  } as Project;

  it('shows the reason and links to the directions panel', async () => {
    mockFetch((req: RecordedRequest) => {
      if (req.url.pathname === '/api/studio/me')
        return ok({
          me: { capabilities: ['studio:project:read'], user: { platformRole: 'user' } },
        });
      return ok({ data: [vague, other, restricted], nextCursor: null });
    });
    renderScreen(<ProjectsList />);
    const link = (await screen.findByText('space video')).closest('a');
    expect(link).toHaveAttribute('href', '/projects/prj_v#directions');
    expect(within(link as HTMLElement).getByTestId('project-row-reason')).toHaveTextContent(
      'The brief was too vague to plan a video. Choose one of the suggested directions.',
    );
    const plain = (await screen.findByText('Bread')).closest('a');
    expect(plain).toHaveAttribute('href', '/projects/prj_ok');
    expect(within(plain as HTMLElement).queryByTestId('project-row-reason')).toBeNull();
    // Spec 13.3: restricted topics waiting for confirmation link to their own panel.
    const topics = (await screen.findByText('Election offer')).closest('a');
    expect(topics).toHaveAttribute('href', '/projects/prj_r#restricted-topics');
    expect(within(topics as HTMLElement).getByTestId('project-row-reason')).toHaveTextContent(
      'The brief touches a restricted topic. Confirm it to continue.',
    );
  });
});

describe('Onboarding first video', () => {
  it('shows the hint under a short brief and still offers Create', async () => {
    mockFetch((req: RecordedRequest) => {
      if (req.url.pathname === '/api/studio/templates')
        return ok({
          data: [
            {
              id: 'tpl_intro',
              organisationId: null,
              builtIn: true,
              name: 'Introduce yourself and what you do',
              category: 'intro',
              targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 30 }],
              shotBlueprint: null,
              publishDefaults: null,
              createdAt: '2026-09-01T00:00:00.000Z',
            },
          ],
        });
      return ok({ data: [] });
    });
    renderScreen(<FirstVideoStep businessId="biz_1" projectId={null} onCreated={vi.fn()} />);
    const box = await screen.findByRole('textbox');
    await userEvent.type(box, 'hi');
    expect(screen.getByTestId('brief-hint')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make my intro video' })).toBeEnabled();
  });
});
