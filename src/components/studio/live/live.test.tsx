// @vitest-environment jsdom
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveProjectEvent } from '@/lib/studio/live/events';
import { mockFetch, ok } from '../publications/test-utils';
import { anyInProgress, idsKey, mergeStatuses, parseLiveEvent } from './live-model';
import { StatusChip } from './status-chip';
import { MAX_ERRORS, useLiveProjects } from './use-live-projects';
import { LIVE_REFRESH_DEBOUNCE_MS, useLiveRefetch } from './use-live-refetch';

// 24.2 — live status in the browser: event parsing / merging, the EventSource hook (live,
// fallback to polling) and the status chip with its ETA.

const T0 = Date.parse('2026-10-06T10:00:00Z');

function ev(projectId: string, over: Partial<LiveProjectEvent> = {}): LiveProjectEvent {
  return {
    projectId,
    state: 'ASSETS_GENERATING',
    stage: 'making_clips',
    format: 'slideshow',
    progressPct: 40,
    etaSec: 60,
    startedAt: new Date(T0).toISOString(),
    thumbnailUrl: null,
    at: new Date(T0).toISOString(),
    ...over,
  };
}

/** A controllable EventSource stand-in. */
class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 0;
  url: string;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(e: MessageEvent<string>) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? [])
      fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeEventSource.instances = [];
});

describe('live model', () => {
  it('parses events defensively', () => {
    expect(parseLiveEvent(JSON.stringify(ev('p')))).toEqual(ev('p'));
    expect(
      parseLiveEvent(JSON.stringify({ ...ev('p'), stage: 'nope', format: 'x' })),
    ).toMatchObject({
      stage: null,
      format: null,
    });
    expect(parseLiveEvent('{"projectId":"p"}')).toBeNull();
    expect(parseLiveEvent('nope')).toBeNull();
  });

  it('keeps the newer snapshot and never mutates', () => {
    const known = new Map([['p', ev('p', { at: '2026-10-06T10:05:00Z' })]]);
    const older = ev('p', { state: 'PLANNING', at: '2026-10-06T10:00:00Z' });
    expect(mergeStatuses(known, [older])).toBe(known);
    const newer = ev('p', { state: 'RENDERING', at: '2026-10-06T10:06:00Z' });
    const merged = mergeStatuses(known, [newer]);
    expect(merged.get('p')?.state).toBe('RENDERING');
    expect(known.get('p')?.state).toBe('ASSETS_GENERATING');
    expect(anyInProgress(merged)).toBe(true);
    expect(anyInProgress(new Map([['p', ev('p', { stage: 'ready' })]]))).toBe(false);
  });

  it('builds a stable id key', () => {
    expect(idsKey(['b', null, 'a', 'b', undefined])).toBe('a,b');
    expect(idsKey(['c', 'b', 'a'], 2)).toBe('a,b');
  });
});

describe('useLiveProjects', () => {
  it('goes live, applies project events and reports them', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    mockFetch(() => ok({ projects: [ev('p1', { at: '2026-10-06T09:00:00Z' })] }));
    const onEvent = vi.fn();
    const { result } = renderHook(() => useLiveProjects('p1', onEvent), { wrapper });
    expect(result.current.mode).toBe('connecting');
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe('/api/studio/live/projects');
    await waitFor(() => expect(result.current.statuses.get('p1')?.at).toBe('2026-10-06T09:00:00Z'));
    act(() => source.emit('ready'));
    expect(result.current.mode).toBe('live');
    act(() => source.emit('project', ev('p1', { state: 'RENDERING', stage: 'composing' })));
    expect(result.current.statuses.get('p1')?.state).toBe('RENDERING');
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }));
  });

  it(`falls back to polling after ${MAX_ERRORS} errors or when the server has no bus`, () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    mockFetch(() => ok({ projects: [] }));
    const { result } = renderHook(() => useLiveProjects(''), { wrapper });
    const first = FakeEventSource.instances[0]!;
    act(() => {
      for (let i = 0; i < MAX_ERRORS; i += 1) first.onerror?.();
    });
    expect(result.current.mode).toBe('polling');
    expect(first.closed).toBe(true);

    const { result: other } = renderHook(() => useLiveProjects(''), { wrapper });
    const second = FakeEventSource.instances[1]!;
    act(() => second.emit('unavailable'));
    expect(other.current.mode).toBe('polling');
  });

  it('polls when the browser has no EventSource', () => {
    vi.stubGlobal('EventSource', undefined);
    mockFetch(() => ok({ projects: [] }));
    const { result } = renderHook(() => useLiveProjects(''), { wrapper });
    expect(result.current.mode).toBe('polling');
  });

  it('closes the stream on unmount', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    mockFetch(() => ok({ projects: [] }));
    const { unmount } = renderHook(() => useLiveProjects(''), { wrapper });
    unmount();
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });
});

describe('useLiveRefetch', () => {
  it('stops polling while live, refetches once per burst, and kicks a refetch on fallback', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    mockFetch(() => ok({ projects: [] }));
    const refetch = vi.fn();
    const liveOpen = { current: false };
    renderHook(() => useLiveRefetch('', refetch, liveOpen, (e) => e.projectId !== 'skip'), {
      wrapper,
    });
    const source = FakeEventSource.instances[0]!;
    act(() => source.emit('ready'));
    expect(liveOpen.current).toBe(true);
    act(() => {
      source.emit('project', ev('a'));
      source.emit('project', ev('b'));
      source.emit('project', ev('skip'));
    });
    expect(refetch).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(LIVE_REFRESH_DEBOUNCE_MS));
    expect(refetch).toHaveBeenCalledTimes(1);
    act(() => source.emit('unavailable'));
    expect(liveOpen.current).toBe(false);
    expect(refetch).toHaveBeenCalledTimes(2);
  });
});

describe('StatusChip', () => {
  it('shows the stage with an ETA that counts down, and a progress bar', () => {
    vi.useFakeTimers({ now: T0 + 30_000 });
    render(<StatusChip live={ev('p', { format: 'ai_video' })} />);
    expect(screen.getByText('Making clips · ~6 min')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Making clips' })).toHaveAttribute(
      'aria-valuenow',
      '20',
    );
    act(() => vi.advanceTimersByTime(330_000));
    expect(screen.getByText('Making clips · ~2 min')).toBeInTheDocument();
  });

  it('says "almost done" past the p50 and shows made stages without ETA', () => {
    vi.useFakeTimers({ now: T0 + 999_000 });
    const { rerender } = render(
      <StatusChip live={ev('p', { stage: 'composing', state: 'RENDERING' })} />,
    );
    expect(screen.getByText('Composing · almost done')).toBeInTheDocument();
    rerender(<StatusChip projectState="APPROVED" publicationState="SCHEDULED" />);
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
    rerender(<StatusChip publicationState="FAILED" />);
    expect(screen.getByText('Failed').closest('[data-live-stage]')).toHaveAttribute(
      'data-live-stage',
      'failed',
    );
    rerender(<StatusChip projectState="DRAFT" />);
    expect(screen.queryByText(/./)).toBeNull();
  });
});
