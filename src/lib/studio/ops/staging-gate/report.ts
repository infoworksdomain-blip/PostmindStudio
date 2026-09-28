import { ValidationError } from '../../../errors';

// Phase 14.5–14.9 — the staging gate's result files (ops/results/<date>-<check>.json + .md).
// Every check produces one GateReport; the CLI (scripts/ops/staging-gate.ts) writes both files
// and runbooks/staging-gate.md's results table links them. Pure: no I/O.

export type Verdict = 'PASS' | 'FAIL' | 'INCOMPLETE';

export interface GateSection {
  title: string;
  verdict?: Verdict;
  lines: string[];
}

export interface GateReport {
  /** Short check id used in file names: k6-smoke, rehearse-kill-switch, restore-check, … */
  check: string;
  title: string;
  verdict: Verdict;
  startedAt: string;
  finishedAt: string;
  /** Who / where, for the GATE 12 table (operator, target URL — never a secret). */
  context: Record<string, string>;
  sections: GateSection[];
  /** Machine-readable detail (samples, metric values, counts). */
  data: Record<string, unknown>;
}

const CHECK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `ops/results/2026-09-28-k6-smoke` (UTC date; no extension). */
export function resultBaseName(check: string, at: Date, dir = 'ops/results'): string {
  if (!CHECK_ID.test(check)) throw new ValidationError(`Invalid check id "${check}"`);
  return `${dir.replace(/[\\/]+$/, '')}/${at.toISOString().slice(0, 10)}-${check}`;
}

/** PASS only when every section with a verdict passed; any FAIL wins over INCOMPLETE. */
export function combineVerdicts(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.length === 0) return 'INCOMPLETE';
  if (verdicts.includes('FAIL')) return 'FAIL';
  if (verdicts.includes('INCOMPLETE')) return 'INCOMPLETE';
  return 'PASS';
}

export function formatMarkdown(report: GateReport): string {
  const lines = [
    `# ${report.title}`,
    '',
    `**Verdict: ${report.verdict}**`,
    '',
    '| | |',
    '| --- | --- |',
    `| Check | \`${report.check}\` |`,
    `| Started | ${report.startedAt} |`,
    `| Finished | ${report.finishedAt} |`,
    ...Object.entries(report.context).map(([k, v]) => `| ${k} | ${v.replace(/\|/g, '\\|')} |`),
    '',
  ];
  for (const section of report.sections) {
    lines.push(`## ${section.title}${section.verdict ? ` — ${section.verdict}` : ''}`, '');
    lines.push(...section.lines, '');
  }
  lines.push(
    'Record this result in runbooks/staging-gate.md (results table) and PROGRESS.md (GATE 12).',
    '',
  );
  return lines.join('\n');
}

/** Removes credentials from a URL before it goes into a report (postgres://u:p@h/db → …@h/db). */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|password|key/i.test(key)) url.searchParams.set(key, '***');
    }
    return url.toString();
  } catch {
    return '<unparseable url>';
  }
}
