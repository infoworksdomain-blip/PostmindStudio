import { ValidationError } from '../../../errors';
import { REHEARSAL_LEVELS, type RehearsalLevel } from '../rehearsal';

// Phase 14.5–14.9 — argument parsing for scripts/ops/staging-gate.ts (pure; unit tested).
//
//   --k6 smoke|full
//   --rehearse kill-switch|rollback|all [--levels provider,platform,…] [--workspace <orgId>]
//              [--project <projectId>] [--provider <providerId>] [--platform <platform>]
//              [--observe-seconds 90] [--from-tag <N> --to-tag <N+1>]
//   --snapshot [--snapshot-file <path>]
//   --restore-check [--snapshot-file <path>] [--incident-at <ISO>] [--restore-started-at <ISO>]
//                   [--restore-target <ISO>]
//   --live-providers [--confirm] [--only runway,luma,…] [--no-posts] [--no-providers]
//   --corpus-preflight <manifest> [--sample <n>] [--workers <n>]
//   common: [--out-dir ops/results] [--operator <name>]

export type K6Mode = 'smoke' | 'full';
export type RehearseWhat = 'kill-switch' | 'rollback' | 'all';

export interface CommonArgs {
  outDir: string;
  operator?: string;
}

export type GateCommand =
  | ({ kind: 'k6'; mode: K6Mode } & CommonArgs)
  | ({
      kind: 'rehearse';
      what: RehearseWhat;
      levels: RehearsalLevel[];
      targets: Partial<Record<Exclude<RehearsalLevel, 'global'>, string>>;
      observeSeconds: number;
      fromTag?: string;
      toTag?: string;
    } & CommonArgs)
  | ({ kind: 'snapshot'; snapshotFile: string } & CommonArgs)
  | ({
      kind: 'restore-check';
      snapshotFile: string;
      incidentAt?: string;
      restoreStartedAt?: string;
      restoreTarget?: string;
    } & CommonArgs)
  | ({
      kind: 'live-providers';
      confirm: boolean;
      only?: string[];
      posts: boolean;
      providers: boolean;
    } & CommonArgs)
  | ({ kind: 'corpus-preflight'; manifest: string; sample?: number; workers: number } & CommonArgs);

export const DEFAULT_SNAPSHOT_FILE = 'ops/results/restore-snapshot.json';
export const USAGE = [
  'usage: npx tsx scripts/ops/staging-gate.ts <check> [options]',
  '  --k6 smoke|full',
  '  --rehearse kill-switch|rollback|all [--levels a,b] [--workspace id] [--project id]',
  '             [--provider id] [--platform p] [--observe-seconds 90] [--from-tag N --to-tag N+1]',
  '  --snapshot [--snapshot-file path]',
  '  --restore-check [--snapshot-file path] [--incident-at ISO] [--restore-started-at ISO]',
  '                  [--restore-target ISO]',
  '  --live-providers [--confirm] [--only runway,luma] [--no-posts] [--no-providers]',
  '  --corpus-preflight <manifest.csv|.jsonl> [--sample n] [--workers n]',
  '  common: [--out-dir ops/results] [--operator name]',
].join('\n');

const CHECKS = [
  '--k6',
  '--rehearse',
  '--snapshot',
  '--restore-check',
  '--live-providers',
  '--corpus-preflight',
] as const;
const VALUE_FLAGS = new Set([
  '--levels',
  '--workspace',
  '--project',
  '--provider',
  '--platform',
  '--observe-seconds',
  '--from-tag',
  '--to-tag',
  '--snapshot-file',
  '--incident-at',
  '--restore-started-at',
  '--restore-target',
  '--only',
  '--sample',
  '--workers',
  '--out-dir',
  '--operator',
]);
const BOOL_FLAGS = new Set(['--confirm', '--no-posts', '--no-providers']);
/** Image tags: registry tag grammar (no shell metacharacters reach the deploy command). */
export const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function isoOrThrow(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new ValidationError(`${flag} must be an ISO date-time`);
  return new Date(t).toISOString();
}

function positiveInt(flag: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`${flag} must be a whole number`);
  return n;
}

function list(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) throw new ValidationError('an empty list was given');
  return items;
}

interface Scanned {
  check?: (typeof CHECKS)[number];
  checkValue?: string;
  values: Map<string, string>;
  bools: Set<string>;
}

function scan(argv: readonly string[]): Scanned {
  const out: Scanned = { values: new Map(), bools: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if ((CHECKS as readonly string[]).includes(arg)) {
      if (out.check) throw new ValidationError('run one check at a time');
      out.check = arg as (typeof CHECKS)[number];
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.checkValue = next;
        i += 1;
      }
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new ValidationError(`${arg} needs a value`);
      out.values.set(arg, value);
      i += 1;
    } else if (BOOL_FLAGS.has(arg)) out.bools.add(arg);
    else throw new ValidationError(`unknown argument ${arg}\n${USAGE}`);
  }
  if (!out.check) throw new ValidationError(USAGE);
  return out;
}

function rehearseCommand(s: Scanned, common: CommonArgs): GateCommand {
  const what = s.checkValue as RehearseWhat | undefined;
  if (what !== 'kill-switch' && what !== 'rollback' && what !== 'all') {
    throw new ValidationError('--rehearse needs kill-switch, rollback or all');
  }
  const levels = (list(s.values.get('--levels')) ?? [...REHEARSAL_LEVELS]) as RehearsalLevel[];
  for (const level of levels) {
    if (!REHEARSAL_LEVELS.includes(level)) {
      throw new ValidationError(`--levels: unknown level ${level}`);
    }
  }
  const targets = {
    workspace: s.values.get('--workspace'),
    project: s.values.get('--project'),
    provider: s.values.get('--provider'),
    platform: s.values.get('--platform'),
  };
  const fromTag = s.values.get('--from-tag');
  const toTag = s.values.get('--to-tag');
  for (const tag of [fromTag, toTag]) {
    if (tag !== undefined && !IMAGE_TAG.test(tag)) {
      throw new ValidationError(`invalid image tag "${tag}"`);
    }
  }
  const observeSeconds = positiveInt('--observe-seconds', s.values.get('--observe-seconds'), 90);
  if (observeSeconds < 60) throw new ValidationError('--observe-seconds must be at least 60');
  return {
    kind: 'rehearse',
    what,
    levels,
    targets: Object.fromEntries(Object.entries(targets).filter(([, v]) => v !== undefined)),
    observeSeconds,
    fromTag,
    toTag,
    ...common,
  };
}

export function parseGateArgs(argv: readonly string[]): GateCommand {
  const s = scan(argv);
  const common: CommonArgs = {
    outDir: s.values.get('--out-dir') ?? 'ops/results',
    operator: s.values.get('--operator'),
  };
  const snapshotFile = s.values.get('--snapshot-file') ?? DEFAULT_SNAPSHOT_FILE;
  const takesValue =
    s.check === '--k6' || s.check === '--rehearse' || s.check === '--corpus-preflight';
  if (!takesValue && s.checkValue !== undefined) {
    throw new ValidationError(`unexpected argument ${s.checkValue}`);
  }
  switch (s.check) {
    case '--k6': {
      if (s.checkValue !== 'smoke' && s.checkValue !== 'full') {
        throw new ValidationError('--k6 needs smoke or full');
      }
      return { kind: 'k6', mode: s.checkValue, ...common };
    }
    case '--rehearse':
      return rehearseCommand(s, common);
    case '--snapshot':
      return { kind: 'snapshot', snapshotFile, ...common };
    case '--restore-check':
      return {
        kind: 'restore-check',
        snapshotFile,
        incidentAt: isoOrThrow('--incident-at', s.values.get('--incident-at')),
        restoreStartedAt: isoOrThrow('--restore-started-at', s.values.get('--restore-started-at')),
        restoreTarget: isoOrThrow('--restore-target', s.values.get('--restore-target')),
        ...common,
      };
    case '--live-providers':
      return {
        kind: 'live-providers',
        confirm: s.bools.has('--confirm'),
        only: list(s.values.get('--only')),
        posts: !s.bools.has('--no-posts'),
        providers: !s.bools.has('--no-providers'),
        ...common,
      };
    case '--corpus-preflight': {
      if (!s.checkValue) throw new ValidationError('--corpus-preflight needs a manifest path');
      const sample = s.values.get('--sample');
      return {
        kind: 'corpus-preflight',
        manifest: s.checkValue,
        sample: sample === undefined ? undefined : positiveInt('--sample', sample, 1),
        workers: positiveInt('--workers', s.values.get('--workers'), 1),
        ...common,
      };
    }
    default:
      throw new ValidationError(USAGE);
  }
}
