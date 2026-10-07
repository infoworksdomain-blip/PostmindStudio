import type { LiveFormat, LiveStage } from './eta';

// BACKLOG 24.2 — live project status. When a project's state changes (pipeline transitions,
// failures, the publish roll-up), the writer announces { projectId } on its organisation's
// channel; the SSE route (GET /api/studio/live/projects) listens on the signed-in member's
// organisation channel ONLY, reloads the project scoped to that organisation and sends the
// browser a LiveProjectEvent. The channel carries ids only, never content.

/** What a writer announces (the bus message). */
export interface ProjectChange {
  projectId: string;
}

/** What the browser receives (one SSE `project` event). */
export interface LiveProjectEvent {
  projectId: string;
  /** VideoProjectState. */
  state: string;
  stage: LiveStage | null;
  format: LiveFormat | null;
  progressPct: number | null;
  etaSec: number | null;
  /** When this run started (metadata.generationStart.at), so the chip can count down. */
  startedAt: string | null;
  /** The latest render's poster (signed, 1 h) once the post is ready. */
  thumbnailUrl: string | null;
  /** Server time of the snapshot. */
  at: string;
}

export type ProjectChangeListener = (change: ProjectChange) => void;

export interface ProjectEventBus {
  publish(organisationId: string, change: ProjectChange): Promise<void>;
  /** Listen to one organisation's changes; resolves to an unsubscribe function. */
  subscribe(organisationId: string, listener: ProjectChangeListener): Promise<() => Promise<void>>;
}

export function liveChannel(prefix: string, organisationId: string): string {
  return `${prefix}:live:org:${organisationId}`;
}

export function parseProjectChange(raw: string): ProjectChange | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      value !== null &&
      typeof value === 'object' &&
      'projectId' in value &&
      typeof value.projectId === 'string' &&
      value.projectId.length > 0 &&
      value.projectId.length <= 128
    )
      return { projectId: value.projectId };
    return null;
  } catch {
    return null;
  }
}

/** In-process bus (tests, and a single process without Redis). */
export function createMemoryProjectEventBus(): ProjectEventBus & {
  listenerCount(organisationId: string): number;
} {
  const listeners = new Map<string, Set<ProjectChangeListener>>();
  return {
    async publish(organisationId, change) {
      for (const listener of [...(listeners.get(organisationId) ?? [])]) listener({ ...change });
    },
    async subscribe(organisationId, listener) {
      const set = listeners.get(organisationId) ?? new Set<ProjectChangeListener>();
      set.add(listener);
      listeners.set(organisationId, set);
      return async () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(organisationId);
      };
    },
    listenerCount: (organisationId) => listeners.get(organisationId)?.size ?? 0,
  };
}
