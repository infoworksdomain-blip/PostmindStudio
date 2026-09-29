import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runTsx } from '../../../../test/helpers/run-process';
import {
  ENV_NAMES,
  envFileTemplate,
  maskKeyId,
  mergeSettingsSources,
  parseEnvFile,
  r2Endpoint,
  renderRcloneConfig,
  validateSettings,
} from './corpus-rclone';

const REPO = join(__dirname, '..', '..', '..', '..');
// Fake values in the documented shapes (a 64-hex secret, a 32-hex account ID).
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const KEY_ID = 'fedcba9876543210fedcba9876543210';
const SECRET = 'a'.repeat(32) + 'b'.repeat(32);

const valid = {
  [ENV_NAMES.accessKeyId]: KEY_ID,
  [ENV_NAMES.secretAccessKey]: SECRET,
  [ENV_NAMES.accountId]: ACCOUNT,
  [ENV_NAMES.jurisdiction]: 'eu',
};

describe('env file', () => {
  it('parses KEY=VALUE with comments, CRLF, a BOM and quotes', () => {
    expect(
      parseEnvFile('﻿# comment\r\nA=1\r\n\r\nB = "two words"\nC=\'x\'\nnot a line\nD=\n'),
    ).toEqual({ A: '1', B: 'two words', C: 'x', D: '' });
  });

  it('the template has empty placeholders for the key and the given account ID', () => {
    const text = envFileTemplate({ accountId: ACCOUNT });
    const parsed = parseEnvFile(text);
    expect(parsed).toEqual({
      CORPUS_R2_ACCESS_KEY_ID: '',
      CORPUS_R2_SECRET_ACCESS_KEY: '',
      R2_ACCOUNT_ID: ACCOUNT,
      R2_JURISDICTION: 'eu',
    });
    expect(text).toContain('\r\n');
  });

  it('prefers the environment over the file and says where each value came from', () => {
    const { values, sources } = mergeSettingsSources(
      { [ENV_NAMES.accessKeyId]: 'fromenv', [ENV_NAMES.secretAccessKey]: '  ' },
      { [ENV_NAMES.accessKeyId]: 'fromfile', [ENV_NAMES.secretAccessKey]: 'filesecret' },
    );
    expect(values[ENV_NAMES.accessKeyId]).toBe('fromenv');
    expect(values[ENV_NAMES.secretAccessKey]).toBe('filesecret');
    expect(sources).toEqual({
      CORPUS_R2_ACCESS_KEY_ID: 'environment',
      CORPUS_R2_SECRET_ACCESS_KEY: 'env file',
      R2_ACCOUNT_ID: 'missing',
      R2_JURISDICTION: 'missing',
    });
  });
});

describe('validateSettings', () => {
  it('accepts well-formed settings', () => {
    expect(validateSettings(valid)).toEqual({
      accessKeyId: KEY_ID,
      secretAccessKey: SECRET,
      accountId: ACCOUNT,
      jurisdiction: 'eu',
    });
  });

  it('names what is missing or wrong, never the value', () => {
    expect(() => validateSettings({ ...valid, [ENV_NAMES.secretAccessKey]: '' })).toThrow(
      /Missing CORPUS_R2_SECRET_ACCESS_KEY/,
    );
    const wrong = 'not-a-secret-value-with spaces';
    let message = '';
    try {
      validateSettings({ ...valid, [ENV_NAMES.secretAccessKey]: wrong });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('CORPUS_R2_SECRET_ACCESS_KEY is not an R2 Secret Access Key');
    expect(message).not.toContain(wrong);
    expect(() => validateSettings({ ...valid, [ENV_NAMES.accessKeyId]: 'has space' })).toThrow(
      /Access Key ID/,
    );
    expect(() =>
      validateSettings({ ...valid, [ENV_NAMES.accountId]: 'evil.example.com/' }),
    ).toThrow(/account ID/);
    expect(() => validateSettings({ ...valid, [ENV_NAMES.jurisdiction]: 'mars' })).toThrow(
      /R2_JURISDICTION/,
    );
  });
});

describe('renderRcloneConfig', () => {
  it('writes the Cloudflare remote with the EU endpoint and no_check_bucket', () => {
    const conf = renderRcloneConfig(validateSettings(valid));
    expect(conf).toContain('[postmind-corpus]\ntype = s3\nprovider = Cloudflare\n');
    expect(conf).toContain(`endpoint = https://${ACCOUNT}.eu.r2.cloudflarestorage.com\n`);
    expect(conf).toContain('region = auto\n');
    expect(conf).toContain('acl = private\n');
    expect(conf).toContain('no_check_bucket = true\n');
    expect(conf).toContain(`secret_access_key = ${SECRET}\n`);
  });

  it('uses the default endpoint without a jurisdiction and refuses odd remote names', () => {
    expect(r2Endpoint(ACCOUNT, '')).toBe(`https://${ACCOUNT}.r2.cloudflarestorage.com`);
    expect(() => renderRcloneConfig(validateSettings(valid), 'bad]\n[x')).toThrow(/remote name/);
  });

  it('masks the key ID', () => {
    expect(maskKeyId(KEY_ID)).toBe('fedc…3210');
    expect(maskKeyId('short')).toBe('…');
  });
});

describe('rclone-config.ts (end to end)', () => {
  let home: string;
  const run = (args: string[], env: Record<string, string> = {}) => {
    const clean = { ...process.env };
    for (const name of Object.values(ENV_NAMES)) delete clean[name];
    return runTsx(join(REPO, 'scripts/corpus/rclone-config.ts'), args, {
      cwd: REPO,
      env: { ...clean, LOG_LEVEL: 'silent', ...env },
    });
  };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'corpus-rclone-'));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('--init writes the env template, then the config holds the secret and stdout never does', async () => {
    const envFile = join(home, 'postmind-corpus.env');
    const conf = join(home, '.config', 'rclone', 'postmind-corpus.conf');
    const init = await run(['--init', '--env-path', envFile, '--account-id', ACCOUNT]);
    expect(init.status, init.stderr).toBe(0);
    expect(init.stdout).toContain('Notepad');
    expect(parseEnvFile(readFileSync(envFile, 'utf8'))[ENV_NAMES.accountId]).toBe(ACCOUNT);

    // Missing values: a clear error, no config written.
    const empty = await run(['--env-path', envFile, '--conf', conf]);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('Missing CORPUS_R2_ACCESS_KEY_ID, CORPUS_R2_SECRET_ACCESS_KEY');
    expect(existsSync(conf)).toBe(false);

    // The operator fills the file in (as Notepad would).
    writeFileSync(
      envFile,
      readFileSync(envFile, 'utf8')
        .replace(`${ENV_NAMES.accessKeyId}=`, `${ENV_NAMES.accessKeyId}=${KEY_ID}`)
        .replace(`${ENV_NAMES.secretAccessKey}=`, `${ENV_NAMES.secretAccessKey}=${SECRET}`),
    );
    const ok = await run(['--env-path', envFile, '--conf', conf]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain(`endpoint:      https://${ACCOUNT}.eu.r2.cloudflarestorage.com`);
    expect(ok.stdout).toContain('fedc…3210');
    expect(ok.stdout + ok.stderr).not.toContain(SECRET);
    expect(ok.stdout + ok.stderr).not.toContain(KEY_ID);
    expect(readFileSync(conf, 'utf8')).toContain(`secret_access_key = ${SECRET}`);

    // A second --init leaves the filled-in file alone.
    expect((await run(['--init', '--env-path', envFile])).stdout).toContain('left unchanged');
    expect(readFileSync(envFile, 'utf8')).toContain(SECRET);
  }, 60_000);

  it('reads the key from the environment and never prints it, even when invalid', async () => {
    const envFile = join(home, 'env-only.env');
    writeFileSync(envFile, envFileTemplate({ accountId: ACCOUNT }));
    const bad = 'Z'.repeat(64);
    const res = await run(['--env-path', envFile, '--conf', join(home, 'x.conf')], {
      [ENV_NAMES.accessKeyId]: KEY_ID,
      [ENV_NAMES.secretAccessKey]: bad,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('is not an R2 Secret Access Key');
    expect(res.stdout + res.stderr).not.toContain(bad);
  }, 60_000);

  it('refuses to write the config or env file inside the repository', async () => {
    const res = await run(['--init', '--env-path', join(REPO, 'postmind-corpus.env')]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('outside the repository');
    expect(existsSync(join(REPO, 'postmind-corpus.env'))).toBe(false);
  }, 60_000);
});
