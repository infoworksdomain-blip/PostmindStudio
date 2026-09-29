import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEGAL_DOCS, PLACEHOLDER_MARKER } from '../legal/documents';
import { backupPathFor, generateSecret, runCheckEnv, runNewEnv, type CliIo } from './cli';

// Phase 19.2 — npm run setup:env / setup:check end to end on temporary files.

const ROOT = join(__dirname, '..', '..', '..');

let dir: string;
let stdout: string;
let stderr: string;
let n = 0;
const io = (): CliIo => ({
  root: ROOT,
  cwd: dir,
  out: (t) => {
    stdout += t;
  },
  err: (t) => {
    stderr += t;
  },
  secret: () => `${'b'.repeat(56)}${String(++n).padStart(8, '0')}`,
  now: () => new Date('2026-09-29T10:00:00Z'),
});

function legalDir(placeholders: boolean): string {
  const legal = join(dir, 'legal', 'en-GB');
  mkdirSync(legal, { recursive: true });
  for (const doc of LEGAL_DOCS)
    writeFileSync(
      join(legal, `${doc}.md`),
      placeholders ? `# ${doc}\n${PLACEHOLDER_MARKER}\n` : `# ${doc}\nOur text.\n`,
    );
  return join(dir, 'legal');
}

/** Fill every empty REQUIRED line of a generated file with a shape-valid fake value. */
function fillRequired(path: string): void {
  const fake: Record<string, string> = {
    ACME_EMAIL: 'ops@example.com',
    STUDIO_DOMAIN: 'studio.example.com',
    STRIPE_SECRET_KEY: 'sk_test_FAKE123',
    STRIPE_WEBHOOK_SECRET: 'whsec_FAKE123',
    RESEND_API_KEY: 're_FAKE123',
    RESEND_WEBHOOK_SECRET: 'whsec_FAKE456',
    STUDIO_EMAIL_FROM: 'Studio <no-reply@mail.example.com>',
    AWS_REGION: 'eu-west-2',
    KMS_KEY_ID: 'alias/studio',
    AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKE0000',
    STUDIO_FONTS_BASE_URL: 'https://fonts.example.com/',
    META_APP_ID: '123',
  };
  const text = readFileSync(path, 'utf8');
  const required = text.slice(text.indexOf('# REQUIRED'), text.indexOf('# OPTIONAL'));
  const filled = required.replace(
    /^([A-Z][A-Z0-9_]*)=$/gm,
    (_l, key: string) => `${key}='${fake[key] ?? `fake-${key.toLowerCase()}`}'`,
  );
  writeFileSync(path, text.replace(required, filled));
  const backup = backupPathFor(path);
  writeFileSync(
    backup,
    readFileSync(backup, 'utf8').replace(/^(S3_BACKUP_[A-Z_]+)=$/gm, "$1='fake-backup-value'"),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-setup-'));
  stdout = '';
  stderr = '';
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('setup:env', () => {
  it('writes the env file and the backup file, and never prints a secret', () => {
    expect(runNewEnv(['--env', 'production', '--out', 'production.env'], io())).toBe(0);
    const text = readFileSync(join(dir, 'production.env'), 'utf8');
    expect(text).toMatch(/^POSTGRES_PASSWORD='b{56}\d{8}'$/m);
    expect(readFileSync(join(dir, 'production.backup.env'), 'utf8')).toMatch(
      /^PG_BACKUP_CIPHER_PASS='b{56}\d{8}'$/m,
    );
    expect(stdout).toContain('POSTGRES_PASSWORD');
    expect(stdout).not.toMatch(/b{56}/);
  });

  it('refuses to overwrite without --force, and replaces with it', () => {
    runNewEnv(['--env', 'staging', '--out', 'staging.env'], io());
    const first = readFileSync(join(dir, 'staging.env'), 'utf8');
    expect(runNewEnv(['--env', 'staging', '--out', 'staging.env'], io())).toBe(1);
    expect(stderr).toContain('already exists');
    expect(readFileSync(join(dir, 'staging.env'), 'utf8')).toBe(first);
    expect(runNewEnv(['--env', 'staging', '--out', 'staging.env', '--force'], io())).toBe(0);
    expect(readFileSync(join(dir, 'staging.env'), 'utf8')).not.toBe(first);
  });

  it('rejects a bad --env or --domain', () => {
    expect(runNewEnv(['--env', 'prod'], io())).toBe(2);
    expect(runNewEnv(['--env', 'production', '--domain', 'https://x.example.com'], io())).toBe(2);
    expect(() => runNewEnv(['--env', 'production', '--out'], io())).toThrow(/needs a value/);
  });

  it('generates 64 hex characters of randomness', () => {
    const a = generateSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSecret()).not.toBe(a);
  });
});

describe('setup:check', () => {
  it('a fresh template is not ready (exit 1) and lists what is missing', async () => {
    runNewEnv(['--env', 'production', '--out', 'production.env'], io());
    stdout = '';
    const code = await runCheckEnv(['production.env', '--legal-dir', legalDir(false)], io());
    expect(code).toBe(1);
    expect(stdout).toMatch(/MISSING\s+STRIPE_SECRET_KEY/);
    expect(stdout).toContain('NOT READY');
  });

  it('a filled file with real legal texts is ready (exit 0) and prints no value', async () => {
    runNewEnv(['--env', 'production', '--out', 'production.env'], io());
    fillRequired(join(dir, 'production.env'));
    stdout = '';
    const code = await runCheckEnv(['production.env', '--legal-dir', legalDir(false)], io());
    expect(stdout).not.toMatch(/MISSING|WRONG/);
    expect(code).toBe(0);
    expect(stdout).toContain('READY');
    expect(stdout).not.toMatch(/b{56}|fake-|FAKE/);
  });

  it('placeholder terms and privacy block readiness unless sign-up is switched off', async () => {
    runNewEnv(['--env', 'production', '--out', 'production.env'], io());
    fillRequired(join(dir, 'production.env'));
    const legal = legalDir(true);
    expect(await runCheckEnv(['production.env', '--legal-dir', legal], io())).toBe(1);
    expect(stdout).toMatch(/MISSING\s+legal texts\s+- terms, privacy/);
    const path = join(dir, 'production.env');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        /^STUDIO_SIGNUPS_ENABLED=$/m,
        "STUDIO_SIGNUPS_ENABLED='false'",
      ),
    );
    stdout = '';
    expect(await runCheckEnv(['production.env', '--legal-dir', legal], io())).toBe(0);
    expect(stdout).toMatch(/CHECK\s+legal texts/);
  });

  it('usage errors exit 2', async () => {
    expect(await runCheckEnv([], io())).toBe(2);
    expect(await runCheckEnv(['nope.env'], io())).toBe(2);
  });
});
