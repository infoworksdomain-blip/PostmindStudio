// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProjectDetail } from '@/lib/client/types';
import { PROVIDER_WAIT_FRESH_MS, QueuedNote, waitingForProvider } from './paused-notes';

// 20.29 — "queued, starting soon" while the run's work waits for a busy video provider.

const NOW = Date.parse('2026-10-03T12:00:00Z');
const project = (state: string, providerWait?: unknown) =>
  ({ id: 'p', state, errorReason: null, metadata: { providerWait } }) as unknown as ProjectDetail;
const wait = (retryInMs: number, from = NOW) => ({
  at: new Date(from).toISOString(),
  retryAt: new Date(from + retryInMs).toISOString(),
});

describe('QueuedNote', () => {
  it('is shown while the run is in progress and the wait is recent', () => {
    expect(waitingForProvider(project('ASSETS_GENERATING', wait(15_000)), NOW)).toBe(true);
    expect(
      waitingForProvider(project('ASSETS_GENERATING', wait(-PROVIDER_WAIT_FRESH_MS - 1)), NOW),
    ).toBe(false);
    expect(waitingForProvider(project('READY_FOR_REVIEW', wait(15_000)), NOW)).toBe(false);
    expect(waitingForProvider(project('ASSETS_GENERATING', { retryAt: 7 }), NOW)).toBe(false);
    expect(waitingForProvider(project('ASSETS_GENERATING'), NOW)).toBe(false);
  });

  it('says the video is queued and will start soon', () => {
    render(<QueuedNote project={project('ASSETS_GENERATING', wait(60_000, Date.now()))} />);
    expect(screen.getByRole('status', { name: 'Queued' })).toHaveTextContent(
      /waiting its turn and will start soon/,
    );
  });

  it('renders nothing otherwise', () => {
    const { container } = render(
      <QueuedNote project={project('FAILED', wait(60_000, Date.now()))} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
