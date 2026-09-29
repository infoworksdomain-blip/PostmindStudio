import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ValidationError } from '../errors';
import { legalReadiness, signupsState } from '../legal/readiness';
import {
  checkEnvFile,
  envRecord,
  formatReport,
  GENERATED_SECRET_KEYS,
  parseEnvFile,
  prefillValues,
  renderBackupTemplate,
  renderTemplate,
  type CheckResult,
} from './env-file';

// Phase 19.2 — the two go-live settings commands (runbooks/go-live.md), testable without a shell:
//   npm run setup:env   -- --env production [--domain studio.example.com] [--out file] [--force]
//   npm run setup:check -- <file> [--backup <file>] [--legal-dir <dir>]
// Output names keys and reasons only; a value is never written to stdout or stderr.

export interface CliIo {
  /** The repository root (deploy/vps/*.example, content/legal). */
  root: string;
  /** Where relative paths on the command line start (npm run: INIT_CWD). Default: root. */
  cwd?: string;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Random secret source (tests inject a fixed one). */
  secret?: () => string;
  now?: () => Date;
}

const EXAMPLE = 'deploy/vps/.env.example';
const BACKUP_EXAMPLE = 'deploy/vps/backup.env.example';

/** 32 random bytes as hex: 64 letters/digits, valid for every generated key (incl. DATABASE_URL). */
export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) throw new ValidationError(`${name} needs a value`);
  return value;
}

/** <dir>/<env>.backup.env next to <dir>/<env>.env. */
export function backupPathFor(envPath: string): string {
  const name = basename(envPath).replace(/\.env$/, '');
  return join(dirname(envPath), `${name}.backup.env`);
}

export function runNewEnv(argv: string[], io: CliIo): number {
  const env = flag(argv, '--env');
  if (env !== 'production' && env !== 'staging') {
    io.err(
      'Usage: npm run setup:env -- --env production|staging [--domain host] [--out file] [--force]\n',
    );
    return 2;
  }
  const domain = flag(argv, '--domain');
  if (domain && !/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(domain)) {
    io.err('--domain must be a host name like studio.example.com (no https://)\n');
    return 2;
  }
  const outFlag = flag(argv, '--out');
  const out = outFlag
    ? resolve(io.cwd ?? io.root, outFlag)
    : resolve(io.root, '.secrets', `${env}.env`);
  const backupOut = backupPathFor(out);
  const force = argv.includes('--force');
  for (const path of [out, backupOut]) {
    if (existsSync(path) && !force) {
      io.err(
        `${path} already exists. Nothing was written. Use --force to replace it (its secrets are lost).\n`,
      );
      return 1;
    }
  }
  const secret = io.secret ?? generateSecret;
  const exampleText = readFileSync(join(io.root, EXAMPLE), 'utf8');
  const values: Record<string, string> = { ...prefillValues(exampleText, env, domain) };
  for (const key of GENERATED_SECRET_KEYS) values[key] = secret();
  mkdirSync(dirname(out), { recursive: true });
  const generatedAt = (io.now?.() ?? new Date()).toISOString().slice(0, 10);
  writeFileSync(out, renderTemplate({ exampleText, env, values, generatedAt }), { mode: 0o600 });
  const backupText = readFileSync(join(io.root, BACKUP_EXAMPLE), 'utf8');
  writeFileSync(backupOut, renderBackupTemplate(backupText, secret()), { mode: 0o600 });
  io.out(
    [
      `Wrote ${out}`,
      `Wrote ${backupOut}`,
      `Generated (random, not shown): ${[...GENERATED_SECRET_KEYS, 'PG_BACKUP_CIPHER_PASS'].join(', ')}`,
      'Next: fill in the empty REQUIRED lines (runbooks/go-live.md), then run',
      `  npm run setup:check -- ${out}`,
      '',
    ].join('\n'),
  );
  return 0;
}

async function legalResults(dir: string, record: Record<string, string>): Promise<CheckResult[]> {
  const readiness = await legalReadiness(dir);
  const state = signupsState(readiness, { ...record, NODE_ENV: 'production' });
  const blockers = readiness.launchBlockers;
  const others = readiness.docs
    .filter((d) => (!d.present || d.placeholder) && !blockers.includes(d.doc))
    .map((d) => d.doc);
  const results: CheckResult[] = [];
  if (blockers.length > 0 && !state.open && state.reason === 'legal_placeholder') {
    results.push({
      key: 'legal texts',
      status: 'missing',
      reason: `${blockers.join(', ')} still the placeholder: public sign-up stays closed (content/legal/en-GB)`,
    });
  } else if (blockers.length > 0) {
    results.push({
      key: 'legal texts',
      status: 'warn',
      reason: `${blockers.join(', ')} still the placeholder (sign-up is switched off, so launch is not blocked)`,
    });
  } else {
    results.push({ key: 'legal texts', status: 'ok' });
  }
  if (others.length > 0)
    results.push({
      key: 'legal texts',
      status: 'warn',
      reason: `${others.join(', ')} still the placeholder (does not block sign-up)`,
    });
  return results;
}

export async function runCheckEnv(argv: string[], io: CliIo): Promise<number> {
  const file = argv.find(
    (a, i) => !a.startsWith('--') && !['--backup', '--legal-dir'].includes(argv[i - 1] ?? ''),
  );
  if (!file) {
    io.err('Usage: npm run setup:check -- <env file> [--backup <file>] [--legal-dir <dir>]\n');
    return 2;
  }
  const cwd = io.cwd ?? io.root;
  const path = resolve(cwd, file);
  if (!existsSync(path)) {
    io.err(`${path} does not exist.\n`);
    return 2;
  }
  const backupPath = resolve(cwd, flag(argv, '--backup') ?? backupPathFor(path));
  const parsed = parseEnvFile(readFileSync(path, 'utf8'));
  const backup = existsSync(backupPath) ? parseEnvFile(readFileSync(backupPath, 'utf8')) : null;
  const report = checkEnvFile({
    exampleText: readFileSync(join(io.root, EXAMPLE), 'utf8'),
    file: parsed,
    backup,
  });
  const legalFlag = flag(argv, '--legal-dir');
  const legalDir = legalFlag ? resolve(cwd, legalFlag) : join(io.root, 'content', 'legal');
  const legal = await legalResults(legalDir, envRecord(parsed));
  const results = [...report.results, ...legal];
  const ready =
    report.ready && !legal.some((r) => r.status === 'missing' || r.status === 'malformed');
  io.out(`Checking ${path}${backup ? ` and ${backupPath}` : ''} (values are never shown)\n\n`);
  io.out(formatReport({ ...report, results, ready }));
  return ready ? 0 : 1;
}
