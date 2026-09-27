// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, mockFetch, ok, renderScreen } from '../publications/test-utils';
import { confidence, StyleMemoryPanel, type StyleMemoryItem } from './style-memory-panel';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const item = (over: Partial<StyleMemoryItem> = {}): StyleMemoryItem => ({
  id: 'sm_1',
  signalType: 'script_structure',
  value: 'hook in the first 1.2 s',
  reason: '3 YouTube videos kept viewers over 60%.',
  weight: 0.7,
  evidenceCount: 4,
  lastEvidenceAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-27T03:15:00.000Z',
  ...over,
});

describe('confidence', () => {
  it('turns the weight into plain language', () => {
    expect(confidence(0.7)).toBe('Strong signal');
    expect(confidence(0.4)).toBe('Emerging signal');
    expect(confidence(0.1)).toContain('not used in scripts yet');
  });
});

describe('StyleMemoryPanel', () => {
  it('lists each learned preference with its reason', async () => {
    const api = mockFetch(() =>
      ok({ data: [item(), item({ id: 'sm_2', signalType: 'posting_time', weight: 0.2 })] }),
    );
    renderScreen(<StyleMemoryPanel businessId="biz_1" />);
    const list = await screen.findByRole('list', { name: 'What Studio has learned' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('Script structure');
    expect(first).toHaveTextContent('hook in the first 1.2 s');
    expect(first).toHaveTextContent('Why: 3 YouTube videos kept viewers over 60%.');
    expect(first).toHaveTextContent('Strong signal · 4 pieces of evidence');
    expect(second).toHaveTextContent('Best time to post');
    expect(api.requests[0]?.url.pathname).toBe('/api/studio/businesses/biz_1/style-memory');
  });

  it('deletes a memory and refreshes the list', async () => {
    let deleted = false;
    const api = mockFetch((req) => {
      if (req.method === 'DELETE') {
        deleted = true;
        return ok({ deleted: true });
      }
      return ok({ data: deleted ? [] : [item()] });
    });
    const user = userEvent.setup();
    renderScreen(<StyleMemoryPanel businessId="biz_1" />);
    await user.click(await screen.findByRole('button', { name: 'Delete Script structure' }));
    expect(await screen.findByText('Nothing learned yet')).toBeInTheDocument();
    expect(api.find('DELETE', '/businesses/biz_1/style-memory/sm_1')).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledWith('Script structure forgotten');
  });

  it('shows a delete failure and the load error state', async () => {
    mockFetch((req) =>
      req.method === 'DELETE' ? fail(404, 'Style memory not found') : ok({ data: [item()] }),
    );
    const user = userEvent.setup();
    const { unmount } = renderScreen(<StyleMemoryPanel businessId="biz_1" />);
    await user.click(await screen.findByRole('button', { name: 'Delete Script structure' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Style memory not found'));
    unmount();
    mockFetch(() => fail(500, 'Memory down'));
    renderScreen(<StyleMemoryPanel businessId="biz_1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Memory down');
  });
});
