// T23 queue-capacity model: the side-by-side Markdown table the runbook quotes.

import type { CapacityResult } from './capacity-options';

/** Human duration: seconds under 2 min, minutes under 2 h, hours above. */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec)) return 'never';
  if (sec < 120) return `${Math.round(sec)} s`;
  if (sec < 7200) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

function laneCell(r: CapacityResult, pick: (l: CapacityResult['lanes'][number]) => string): string {
  return r.lanes.map((l) => `${l.lane} ${pick(l)}`).join(', ');
}

export function renderCapacityMarkdown(results: readonly CapacityResult[]): string {
  const row = (label: string, cell: (r: CapacityResult) => string) =>
    `| ${label} | ${results.map(cell).join(' | ')} |`;
  const d = formatDuration;
  return [
    `| Measure | ${results.map((r) => r.name).join(' | ')} |`,
    `| --- | ${results.map(() => '---').join(' | ')} |`,
    row('Lanes (concurrency)', (r) => laneCell(r, (l) => String(l.concurrency))),
    row(
      'Organisations / items (ready)',
      (r) => `${r.organisations} / ${r.items} (${r.itemsReady})`,
    ),
    row('Drain: every item ready', (r) => d(r.drainSec)),
    row(
      'Initial backlog drain (items eligible at t=0)',
      (r) => `${d(r.initialBacklogDrainSec)} (${r.initialBacklogItems} items)`,
    ),
    row(
      'Time to first ready item per org p50 / p95 / max',
      (r) =>
        `${d(r.timeToFirstReadySec.p50)} / ${d(r.timeToFirstReadySec.p95)} / ${d(r.timeToFirstReadySec.max)}`,
    ),
    row('Late items (ready after slot - 45 min)', (r) => String(r.lateItems)),
    row(
      'Platform tick wait on orchestration p95 / max',
      (r) => `${d(r.tickWaitSec.p95)} / ${d(r.tickWaitSec.max)}`,
    ),
    row('Peak queue depth (waiting jobs)', (r) => laneCell(r, (l) => String(l.peakDepth))),
    row('Jobs processed', (r) => laneCell(r, (l) => String(l.jobs))),
    '',
    // With rolling generation the full drain follows the posting schedule (the last slot minus the
    // lead window), so the initial backlog is the comparable figure.
    '_With rolling generation "every item ready" tracks the schedule (last slot minus the lead ' +
      'window); compare the initial backlog drain instead._',
    '',
  ].join('\n');
}
