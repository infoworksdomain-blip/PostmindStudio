import type { Logger } from 'pino';
import type { LiveProjectEvent, ProjectEventBus } from './events';

// BACKLOG 24.2 — the Server-Sent Events stream behind GET /api/studio/live/projects
// (https://html.spec.whatwg.org/multipage/server-sent-events.html): `retry` once, a `ready`
// event, then one `project` event per change of the organisation's projects. A comment line
// every 25 s keeps proxies (Caddy, Render) from closing an idle stream; the stream ends itself
// after 10 minutes and EventSource reconnects, so no connection lives forever. Aborting the
// request (tab closed, navigation) unsubscribes and closes immediately.

export const HEARTBEAT_MS = 25_000;
export const MAX_STREAM_MS = 10 * 60_000;
export const RETRY_MS = 5_000;

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // Caddy / nginx: do not buffer the stream.
  'x-accel-buffering': 'no',
};

export interface LiveStreamInput {
  bus: ProjectEventBus;
  organisationId: string;
  signal: AbortSignal;
  /** Reloads one project for this organisation (null = not visible to it). */
  snapshot: (projectId: string) => Promise<LiveProjectEvent | null>;
  logger: Logger;
  heartbeatMs?: number;
  maxMs?: number;
}

export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function liveProjectStream(input: LiveStreamInput): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => Promise<void>) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  /** Projects with a snapshot in flight → whether another change arrived meanwhile. */
  const inFlight = new Map<string, boolean>();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  const write = (text: string) => {
    if (closed || !controllerRef) return;
    try {
      controllerRef.enqueue(encoder.encode(text));
    } catch {
      void shutdown();
    }
  };

  async function shutdown(): Promise<void> {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (lifetime) clearTimeout(lifetime);
    input.signal.removeEventListener('abort', onAbort);
    try {
      controllerRef?.close();
    } catch {
      // already closed or errored by the runtime
    }
    const stop = unsubscribe;
    unsubscribe = undefined;
    await stop?.().catch((err: unknown) => input.logger.warn({ err }, 'live unsubscribe failed'));
  }

  function onAbort() {
    void shutdown();
  }

  async function send(projectId: string): Promise<void> {
    if (inFlight.has(projectId)) {
      inFlight.set(projectId, true); // coalesce: one more snapshot after this one
      return;
    }
    inFlight.set(projectId, false);
    try {
      const event = await input.snapshot(projectId);
      if (event) write(sseEvent('project', event));
    } catch (err) {
      input.logger.warn({ err, projectId }, 'live snapshot failed');
    }
    const again = inFlight.get(projectId);
    inFlight.delete(projectId);
    if (again && !closed) await send(projectId);
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      if (input.signal.aborted) {
        await shutdown();
        return;
      }
      input.signal.addEventListener('abort', onAbort);
      write(`retry: ${RETRY_MS}\n\n`);
      try {
        const stop = await input.bus.subscribe(input.organisationId, (change) => {
          void send(change.projectId);
        });
        if (closed) {
          await stop();
          return;
        }
        unsubscribe = stop;
      } catch (err) {
        input.logger.warn({ err }, 'live subscribe failed');
        write(sseEvent('unavailable', {}));
        await shutdown();
        return;
      }
      write(sseEvent('ready', {}));
      heartbeat = setInterval(() => write(': ping\n\n'), input.heartbeatMs ?? HEARTBEAT_MS);
      lifetime = setTimeout(() => void shutdown(), input.maxMs ?? MAX_STREAM_MS);
    },
    async cancel() {
      await shutdown();
    },
  });
}
