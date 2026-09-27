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

  it('humanises check codes', () => {
    expect(humanCode('safety.hive_block')).toBe('Safety hive block');
  });
});
