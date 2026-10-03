// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { humanCode, isHardFailure, QualityPanel } from './quality-panel';
import { makeRender, mockFetch, renderWithSWR } from './test-helpers';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

describe('QualityPanel', () => {
  it('lists failures first with their detail', () => {
    mockFetch([]);
    renderWithSWR(
      <QualityPanel
        onChanged={vi.fn()}
        render={makeRender({
          qualityCheckState: 'FAILED',
          qualityIssues: [
            { code: 'audio_loudness', status: 'passed', severity: 'info', detail: 'OK' },
            { code: 'text_legibility', status: 'failed', severity: 'error', detail: 'Too small' },
          ],
        })}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Failed: Text legibility');
    expect(items[0]).toHaveTextContent('Too small');
    expect(items[1]).toHaveTextContent('Passed: Audio loudness');
  });

  it('force-approves a failed render with a reason', async () => {
    const onChanged = vi.fn();
    const api = mockFetch([
      {
        method: 'POST',
        match: '/renders/ren_1/force-approve',
        body: { ok: true, renderId: 'ren_1', projectReadyForReview: true },
      },
    ]);
    renderWithSWR(
      <QualityPanel onChanged={onChanged} render={makeRender({ qualityCheckState: 'FAILED' })} />,
    );
    const button = screen.getByRole('button', { name: 'Force-approve' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Override the failed check/), 'Parody account');
    await userEvent.click(button);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.find('POST', '/renders/ren_1/force-approve')[0]?.body).toEqual({
      note: 'Parody account',
    });
  });

  it('says when checks are pending', () => {
    mockFetch([]);
    renderWithSWR(
      <QualityPanel
        onChanged={vi.fn()}
        render={makeRender({ qualityCheckState: 'PENDING', qualityIssues: null })}
      />,
    );
    expect(screen.getByText('Checks are still running.')).toBeInTheDocument();
  });

  describe('20.21: content safety not scanned', () => {
    const render = makeRender({
      qualityCheckState: 'PASSED',
      qualityIssues: [
        { code: 'duration_match', status: 'passed', severity: 'error', detail: 'OK' },
        {
          code: 'content_safety',
          status: 'not_run',
          severity: 'info',
          detail: 'Not scanned: no content-safety provider is configured',
          detailKey: 'safetyNotScanned',
          detailParams: { reason: 'no_provider' },
        },
      ],
    });
    const me = (platformRole: string) => ({
      method: 'GET',
      match: '/me',
      body: { me: { capabilities: [], user: { platformRole } } },
    });

    it('shows customers nothing about the scan', async () => {
      const api = mockFetch([me('user')]);
      renderWithSWR(<QualityPanel onChanged={vi.fn()} render={render} />);
      await waitFor(() => expect(api.fetchMock).toHaveBeenCalled());
      expect(screen.getAllByRole('listitem')).toHaveLength(1);
      expect(screen.queryByText(/not scanned/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/content safety/i)).not.toBeInTheDocument();
    });

    it('shows staff a neutral "Not scanned"', async () => {
      mockFetch([me('staff')]);
      renderWithSWR(<QualityPanel onChanged={vi.fn()} render={render} />);
      expect(
        await screen.findByText('Not scanned: no content-safety scan is set up.'),
      ).toBeInTheDocument();
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
    });
  });

  describe('20.22: soft failures can be force-approved, a block cannot', () => {
    // QA run 3: TikTok render QUALITY_FAILED on black_frames + caption_sync (both soft).
    const soft = makeRender({
      qualityCheckState: 'FAILED',
      qualityIssues: [
        {
          code: 'black_frames',
          status: 'failed',
          severity: 'error',
          detail: 'black 27.7–30.0s',
          detailKey: 'blackFrames',
          detailParams: { segments: '27.7–30.0' },
        },
        {
          code: 'caption_sync',
          status: 'failed',
          severity: 'error',
          detail: '"Meeting panic mode": words not found in the narration',
          detailKey: 'captionSyncFailed',
          detailParams: { count: 1 },
        },
      ],
    });
    const me = (capabilities: string[]) => ({
      method: 'GET',
      match: '/me',
      body: { me: { capabilities, user: { platformRole: 'user' } } },
    });

    it('offers the override with a clear hint to someone who may force-approve', async () => {
      mockFetch([me(['studio:project:read', 'studio:render:force-approve'])]);
      renderWithSWR(<QualityPanel onChanged={vi.fn()} render={soft} />);
      expect(await screen.findByRole('button', { name: 'Force-approve' })).toBeVisible();
      expect(
        screen.getByText(
          'These checks are advisory. Watch the video; if it looks right, force-approve it with a short reason.',
        ),
      ).toBeInTheDocument();
    });

    it('tells someone without the capability who can approve it', async () => {
      mockFetch([me(['studio:project:read'])]);
      renderWithSWR(<QualityPanel onChanged={vi.fn()} render={soft} />);
      expect(
        await screen.findByText(
          'These checks are advisory. Watch the video; an owner or admin can force-approve it.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Force-approve' })).toBeNull();
    });

    it('offers no override for a content-safety block (staff moderation only)', async () => {
      const api = mockFetch([me(['studio:project:read', 'studio:render:force-approve'])]);
      renderWithSWR(
        <QualityPanel
          onChanged={vi.fn()}
          render={makeRender({
            qualityCheckState: 'FAILED',
            qualityIssues: [
              ...(soft.qualityIssues ?? []),
              {
                code: 'content_safety',
                status: 'failed',
                severity: 'block',
                detail: 'Blocked: yes_nazi=0.99',
              },
            ],
          })}
        />,
      );
      await waitFor(() => expect(api.fetchMock).toHaveBeenCalled());
      expect(
        screen.getByText('A content-safety block can only be cleared by PostMind staff.'),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Force-approve' })).toBeNull();
    });

    it('isHardFailure: only a failed block-severity check', () => {
      expect(isHardFailure(soft.qualityIssues ?? [])).toBe(false);
      expect(isHardFailure([{ status: 'passed', severity: 'block' }])).toBe(false);
      expect(isHardFailure([{ status: 'failed', severity: 'block' }])).toBe(true);
    });
  });

  it('humanises check codes', () => {
    expect(humanCode('safety.provider_block')).toBe('Safety provider block');
  });
});
