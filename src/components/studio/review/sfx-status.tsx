import { AudioLines } from 'lucide-react';
import type { ProjectDetail } from '@/lib/client/types';

// Review screen: Layer 5 sound effects for the latest run (BACKLOG 13.27; pipeline/sfx.ts writes
// project.metadata.sfx). Nothing is shown when the script asked for no effects.

export interface SfxCueView {
  cue: string;
  status: 'added' | 'no_match' | 'failed';
  title: string | null;
  shots: number;
}

export type SfxState =
  | { status: 'added'; cues: SfxCueView[] }
  | { status: 'failed'; cues: SfxCueView[] }
  | { status: 'off_for_plan' }
  | { status: 'unavailable'; reason: string | null };

const CUE_STATUSES = new Set(['added', 'no_match', 'failed']);

function readCues(value: unknown): SfxCueView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((c) => {
    if (!c || typeof c !== 'object') return [];
    const r = c as Record<string, unknown>;
    if (typeof r.cue !== 'string' || !CUE_STATUSES.has(String(r.status))) return [];
    return [
      {
        cue: r.cue,
        status: r.status as SfxCueView['status'],
        title: typeof r.title === 'string' ? r.title : null,
        shots: Array.isArray(r.shotIds) ? r.shotIds.length : 0,
      },
    ];
  });
}

export function readSfx(metadata: unknown): SfxState | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const sfx = (metadata as { sfx?: unknown }).sfx;
  if (!sfx || typeof sfx !== 'object') return null;
  const s = sfx as Record<string, unknown>;
  if (s.status === 'added' || s.status === 'failed')
    return { status: s.status, cues: readCues(s.cues) };
  if (s.status === 'off_for_plan') return { status: 'off_for_plan' };
  if (s.status === 'unavailable')
    return { status: 'unavailable', reason: typeof s.reason === 'string' ? s.reason : null };
  return null; // 'none': the script asked for no effects
}

function summary(state: SfxState): string {
  switch (state.status) {
    case 'added': {
      const added = state.cues.filter((c) => c.status === 'added').length;
      return `Sound effects: ${added} of ${state.cues.length} added.`;
    }
    case 'failed':
      return 'Sound effects could not be added; the video plays without them.';
    case 'off_for_plan':
      return 'No sound effects on this plan.';
    case 'unavailable':
      return 'Sound effects are not set up yet; the video plays without them.';
  }
}

const CUE_NOTE: Record<SfxCueView['status'], string> = {
  added: 'added',
  no_match: 'no matching effect',
  failed: 'could not be fetched',
};

export function SfxStatus({ project }: { project: ProjectDetail }) {
  const state = readSfx(project.metadata);
  if (!state) return null;
  const cues = 'cues' in state ? state.cues : [];
  return (
    <div
      aria-label="Sound effects"
      className="flex items-start gap-2 rounded-lg border border-border/70 px-3 py-2 text-sm"
    >
      <AudioLines
        className={`mt-0.5 size-4 shrink-0 ${state.status === 'failed' ? 'text-amber-600' : 'text-muted-foreground'}`}
        strokeWidth={1.5}
      />
      <div className="min-w-0">
        <p>{summary(state)}</p>
        {cues.length > 0 && (
          <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
            {cues.map((c) => (
              <li key={c.cue}>
                “{c.cue}”{c.title ? ` → ${c.title}` : ''} · {CUE_NOTE[c.status]}
                {c.shots > 1 ? ` · ${c.shots} shots` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
