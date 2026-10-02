// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { humanCode, QualityPanel } from './quality-panel';
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

  it('humanises check codes', () => {
    expect(humanCode('safety.provider_block')).toBe('Safety provider block');
  });
});
