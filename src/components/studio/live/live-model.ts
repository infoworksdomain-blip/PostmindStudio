import type { LiveProjectEvent } from '@/lib/studio/live/events';
import { IN_PROGRESS_STAGES, LIVE_FORMATS, LIVE_STAGES } from '@/lib/studio/live/eta';

// BACKLOG 24.2 — browser side of live status: parse an SSE `project` event defensively and merge
// it into the known statuses (the newer snapshot wins, so a late REST answer never overwrites a
// fresher event).

export type LiveMode = 'connecting' | 'live' | 'polling';

const STAGES: ReadonlySet<string> = new Set(LIVE_STAGES);
const FORMATS: ReadonlySet<string> = new Set(LIVE_FORMATS);

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** A LiveProjectEvent from untrusted JSON, or null. */
export function parseLiveEvent(raw: string): LiveProjectEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const projectId = str(v.projectId);
  const state = str(v.state);
  const at = str(v.at);
  if (!projectId || !state || !at) return null;
  const stage = str(v.stage);
  const format = str(v.format);
  return {
    projectId,
    state,
    stage: stage && STAGES.has(stage) ? (stage as LiveProjectEvent['stage']) : null,
    format: format && FORMATS.has(format) ? (format as LiveProjectEvent['format']) : null,
    progressPct: num(v.progressPct),
    etaSec: num(v.etaSec),
    startedAt: str(v.startedAt),
    thumbnailUrl: str(v.thumbnailUrl),
    at,
  };
}

/** `events` merged into `known`, keeping the newer snapshot per project. Never mutates. */
export function mergeStatuses(
  known: ReadonlyMap<string, LiveProjectEvent>,
  events: readonly LiveProjectEvent[],
): ReadonlyMap<string, LiveProjectEvent> {
  let next: Map<string, LiveProjectEvent> | null = null;
  for (const event of events) {
    const current = (next ?? known).get(event.projectId);
    if (current && Date.parse(current.at) > Date.parse(event.at)) continue;
    next ??= new Map(known);
    next.set(event.projectId, event);
  }
  return next ?? known;
}

/** Some known project is still being made (polling fallback keeps refreshing then). */
export function anyInProgress(statuses: ReadonlyMap<string, LiveProjectEvent>): boolean {
  for (const s of statuses.values()) if (s.stage && IN_PROGRESS_STAGES.has(s.stage)) return true;
  return false;
}

/** A stable request key for a set of ids (sorted, de-duplicated, at most `max`). */
export function idsKey(ids: readonly (string | null | undefined)[], max = 100): string {
  return [...new Set(ids.filter((id): id is string => !!id))].sort().slice(0, max).join(',');
}
