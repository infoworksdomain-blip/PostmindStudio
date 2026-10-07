import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryProjectEventBus, type LiveProjectEvent } from './events';
import { liveProjectStream, sseEvent } from './sse';

const logger = pino({ level: 'silent' });

function event(projectId: string, state = 'RENDERING'): LiveProjectEvent {
  return {
    projectId,
    state,
    stage: 'composing',
    format: 'slideshow',
    progressPct: 80,
    etaSec: 20,
    startedAt: null,
    thumbnailUrl: null,
    at: '2026-10-06T10:00:00.000Z',
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

afterEach(() => vi.useRealTimers());

describe('liveProjectStream', () => {
  it('formats SSE events', () => {
    expect(sseEvent('project', { a: 1 })).toBe('event: project\ndata: {"a":1}\n\n');
  });

  it('sends retry, ready, then a project event per change of its organisation only', async () => {
    const bus = createMemoryProjectEventBus();
    const abort = new AbortController();
    const snapshot = vi.fn(async (id: string) => event(id));
    const reader = liveProjectStream({
      bus,
      organisationId: 'org_a',
      signal: abort.signal,
      snapshot,
      logger,
    }).getReader();
    const start = await readUntil(reader, 'event: ready');
    expect(start).toContain('retry: 5000');
    await bus.publish('org_b', { projectId: 'foreign' });
    await bus.publish('org_a', { projectId: 'p1' });
    const text = await readUntil(reader, '"p1"');
    expect(text).toContain('event: project');
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledWith('p1');
    abort.abort();
    await vi.waitFor(() => expect(bus.listenerCount('org_a')).toBe(0));
  });

  it('skips projects the organisation cannot see', async () => {
    const bus = createMemoryProjectEventBus();
    const abort = new AbortController();
    const reader = liveProjectStream({
      bus,
      organisationId: 'org',
      signal: abort.signal,
      snapshot: async (id) => (id === 'mine' ? event(id) : null),
      logger,
    }).getReader();
    await readUntil(reader, 'event: ready');
    await bus.publish('org', { projectId: 'other' });
    await bus.publish('org', { projectId: 'mine' });
    const text = await readUntil(reader, '"mine"');
    expect(text).not.toContain('"other"');
    abort.abort();
  });

  it('sends a heartbeat comment and closes itself after its lifetime', async () => {
    vi.useFakeTimers();
    const bus = createMemoryProjectEventBus();
    const reader = liveProjectStream({
      bus,
      organisationId: 'org',
      signal: new AbortController().signal,
      snapshot: async () => null,
      logger,
      heartbeatMs: 1_000,
      maxMs: 5_000,
    }).getReader();
    await vi.waitFor(() => expect(bus.listenerCount('org')).toBe(1));
    await vi.advanceTimersByTimeAsync(1_000);
    let text = '';
    const decoder = new TextDecoder();
    for (;;) {
      const next = reader.read();
      await vi.advanceTimersByTimeAsync(1_000);
      const { value, done } = await next;
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain(': ping');
    expect(bus.listenerCount('org')).toBe(0);
  });

  it('coalesces a burst of changes for one project', async () => {
    const bus = createMemoryProjectEventBus();
    const abort = new AbortController();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const snapshot = vi.fn(async (id: string) => {
      await gate;
      return event(id);
    });
    const reader = liveProjectStream({
      bus,
      organisationId: 'org',
      signal: abort.signal,
      snapshot,
      logger,
    }).getReader();
    await readUntil(reader, 'event: ready');
    for (let i = 0; i < 5; i += 1) await bus.publish('org', { projectId: 'p' });
    release();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    abort.abort();
  });

  it('tells the browser when the bus is down and closes', async () => {
    const reader = liveProjectStream({
      bus: {
        publish: async () => undefined,
        subscribe: async () => {
          throw new Error('redis down');
        },
      },
      organisationId: 'org',
      signal: new AbortController().signal,
      snapshot: async () => null,
      logger,
    }).getReader();
    const text = await readUntil(reader, 'never');
    expect(text).toContain('event: unavailable');
  });

  it('does not subscribe when the request is already aborted', async () => {
    const bus = createMemoryProjectEventBus();
    const abort = new AbortController();
    abort.abort();
    const reader = liveProjectStream({
      bus,
      organisationId: 'org',
      signal: abort.signal,
      snapshot: async () => null,
      logger,
    }).getReader();
    expect((await reader.read()).done).toBe(true);
    expect(bus.listenerCount('org')).toBe(0);
  });
});
