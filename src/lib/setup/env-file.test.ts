import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requiredAtStartup } from '../../../test/helpers/required-env';
import { requiredEnvForModes } from '../env';
import { studioModes } from '../mode';
import {
  BACKUP_REQUIRED_KEYS,
  BUCKETS,
  checkEnvFile,
  COMPOSE_SET_KEYS,
  exampleSections,
  formatReport,
  GENERATED_SECRET_KEYS,
  HIVE_ONE_OF_KEYS,
  parseEnvFile,
  prefillValues,
  R2_ACCOUNT_ID,
  renderBackupTemplate,
  renderTemplate,
  requiredKeys,
  stagingOverrides,
  type ParsedEnvFile,
} from './env-file';

// Phase 19.2 — the go-live settings checker. The required list is derived from
// deploy/vps/.env.example and src/lib/env.ts; these tests pin that it stays in step with them,
// with the code's start-up requirements (test/helpers/required-env.ts) and with deploy.sh.

const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const EXAMPLE = read('deploy/vps/.env.example');
const BACKUP_EXAMPLE = read('deploy/vps/backup.env.example');

const standalone = studioModes({ STUDIO_MODE: 'standalone' });
const core = studioModes({ STUDIO_MODE: 'core' });
const req = (modes = standalone, studioEnv = 'production', pgBackups = true) =>
  requiredKeys({ exampleText: EXAMPLE, modes, studioEnv, pgBackups });

// Shape-valid fake values (never real credentials) for a complete standalone production file.
const FILLED: Record<string, string> = {
  ACME_EMAIL: 'ops@example.com',
  STRIPE_SECRET_KEY: 'sk_live_FAKE0123456789abcdef',
  STRIPE_WEBHOOK_SECRET: 'whsec_FAKE0123456789abcdef',
  RESEND_API_KEY: 're_FAKE_0123456789',
  RESEND_WEBHOOK_SECRET: 'whsec_FAKE9876543210',
  STUDIO_EMAIL_FROM: 'PostMind Studio <no-reply@mail.example.com>',
  AWS_REGION: 'eu-west-2',
  KMS_KEY_ID: 'arn:aws:kms:eu-west-2:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab',
  AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKE0000',
  AWS_SECRET_ACCESS_KEY: 'fakeAwsSecretValue0000000000000000000000',
  R2_ACCESS_KEY_ID: 'fakeR2AccessKeyId000000000000000',
  R2_SECRET_ACCESS_KEY: 'fakeR2SecretAccessKey000000000000000000000000000000000000000000',
  ANTHROPIC_API_KEY: 'fake-anthropic-key-value',
  OPENAI_API_KEY: 'fake-openai-key-value',
  ELEVENLABS_API_KEY: 'fake-elevenlabs-key-value',
  ELEVENLABS_DEFAULT_VOICE_ID: 'fakevoiceid',
  SHOTSTACK_API_KEY: 'fake-shotstack-key-value',
  HIVE_API_KEY: 'fake-hive-key-value',
  ASSEMBLYAI_API_KEY: 'fake-assemblyai-key-value',
  STUDIO_FONTS_BASE_URL: 'https://fonts.example.com/studio/',
  META_APP_ID: '1234567890',
  META_APP_SECRET: 'fake-meta-app-secret-value',
  TIKTOK_CLIENT_KEY: 'fake-tiktok-key',
  TIKTOK_CLIENT_SECRET: 'fake-tiktok-secret-value',
  YOUTUBE_CLIENT_ID: 'fake-youtube-client',
  YOUTUBE_CLIENT_SECRET: 'fake-youtube-secret-value',
  X_CLIENT_ID: 'fake-x-client',
  X_CLIENT_SECRET: 'fake-x-secret-value',
  LINKEDIN_CLIENT_ID: 'fake-linkedin-client',
  LINKEDIN_CLIENT_SECRET: 'fake-linkedin-secret-value',
};

let counter = 0;
const secret = () => `${'a'.repeat(56)}${String(++counter).padStart(8, '0')}`;

function filledFile(
  env: 'production' | 'staging' = 'production',
  overrides: Record<string, string> = {},
): string {
  const values: Record<string, string> = {
    ...prefillValues(
      EXAMPLE,
      env,
      env === 'production' ? 'studio.example.com' : 'studio-staging.example.com',
    ),
    ...FILLED,
    ...overrides,
  };
  for (const key of GENERATED_SECRET_KEYS) values[key] ??= secret();
  return renderTemplate({ exampleText: EXAMPLE, env, values, generatedAt: '2026-09-29' });
}
const BACKUP = parseEnvFile(
  renderBackupTemplate(BACKUP_EXAMPLE, secret())
    .replace(/^S3_BACKUP_ACCESS_KEY_ID=$/m, "S3_BACKUP_ACCESS_KEY_ID='fakeBackupKeyId000'")
    .replace(
      /^S3_BACKUP_SECRET_ACCESS_KEY=$/m,
      "S3_BACKUP_SECRET_ACCESS_KEY='fakeBackupSecret000'",
    ),
);
const check = (text: string, backup: ParsedEnvFile | null = BACKUP) =>
  checkEnvFile({ exampleText: EXAMPLE, file: parseEnvFile(text), backup });
const statusOf = (text: string, key: string) =>
  check(text)
    .results.filter((r) => r.key === key)
    .map((r) => r.status);

describe('the required list cannot drift', () => {
  it('includes every key of the REQUIRED section of deploy/vps/.env.example', () => {
    const { required } = exampleSections(EXAMPLE);
    expect(required.length).toBeGreaterThan(30);
    // 20.6: the Hive keys are one-of (checked by hiveChecks), not each required.
    expect(required).toEqual(expect.arrayContaining([...HIVE_ONE_OF_KEYS]));
    const each = required.filter((k) => !HIVE_ONE_OF_KEYS.includes(k));
    expect(req().sort()).toEqual(expect.arrayContaining(each));
    for (const key of HIVE_ONE_OF_KEYS) expect(req()).not.toContain(key);
  });

  it.each([
    ['standalone', standalone],
    ['core', core],
  ] as const)('%s: includes what assertStartupEnv (src/lib/env.ts) requires', (_n, modes) => {
    const fromEnvTs = requiredEnvForModes(modes)
      .map((k) => k.name)
      .filter((k) => !COMPOSE_SET_KEYS.includes(k));
    expect(req(modes)).toEqual(expect.arrayContaining(fromEnvTs));
  });

  it('core mode does not require the standalone secrets, and standalone not the Core ones', () => {
    expect(req(core)).not.toContain('BETTER_AUTH_SECRET');
    expect(req(core)).not.toContain('STRIPE_SECRET_KEY');
    expect(req(core)).toContain('STUDIO_PLATFORM_ORG_IDS');
    expect(req()).not.toContain('POSTMIND_CORE_URL');
    expect(req()).not.toContain('STUDIO_PLATFORM_ORG_IDS');
  });

  it('includes every key the code needs at start-up (requireEnv scan)', () => {
    const missing = requiredAtStartup('standalone').filter(
      (k) => !COMPOSE_SET_KEYS.includes(k) && !req().includes(k),
    );
    expect(missing).toEqual([]);
  });

  it("includes every key deploy.sh's preflight insists on", () => {
    const deploy = read('scripts/vps/deploy.sh');
    const preflight = deploy.slice(
      deploy.indexOf('preflight() {'),
      deploy.indexOf('preflight_edge() {'),
    );
    const keys = new Set<string>();
    for (const m of preflight.matchAll(/require_value ([A-Z][A-Z0-9_]+) "\$ENV_FILE"/g))
      keys.add(m[1]!);
    for (const m of preflight.matchAll(/for key in ([A-Z0-9_ \\\n]+?); do/g))
      for (const k of m[1]!.split(/[\s\\]+/).filter(Boolean)) keys.add(k);
    expect(keys.size).toBeGreaterThan(15);
    const union = new Set([...req(), ...req(core)]);
    expect([...keys].filter((k) => !union.has(k))).toEqual([]);
    for (const m of preflight.matchAll(/require_value ([A-Z][A-Z0-9_]+) "\$BACKUP_ENV_FILE"/g))
      expect(BACKUP_REQUIRED_KEYS).toContain(m[1]);
  });

  it('the keys it leaves to compose really are set by deploy/vps/compose.yml', () => {
    const compose = read('deploy/vps/compose.yml');
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'APP_URL', 'STUDIO_PUBLIC_CALLBACK_BASE_URL'])
      expect(compose, key).toMatch(new RegExp(`\\b${key}:`));
  });

  it('STUDIO_FONTS_BASE_URL is optional (20.7: the app serves its own fonts at /fonts)', () => {
    expect(exampleSections(EXAMPLE).optional).toContain('STUDIO_FONTS_BASE_URL');
    expect(req()).not.toContain('STUDIO_FONTS_BASE_URL');
    expect(req(core)).not.toContain('STUDIO_FONTS_BASE_URL');
    const empty = filledFile('production', { STUDIO_FONTS_BASE_URL: '' });
    expect(statusOf(empty, 'STUDIO_FONTS_BASE_URL')).toEqual([]);
    expect(check(empty).ready).toBe(true);
  });

  it('ACME_EMAIL only in production; the backup bucket only with backups on', () => {
    expect(req(standalone, 'staging')).not.toContain('ACME_EMAIL');
    expect(req(standalone, 'production', false)).not.toContain('S3_BACKUP_BUCKET');
  });
});

describe('parseEnvFile', () => {
  it('reads KEY=value with quotes, skips comments and blanks, flags duplicates and bad lines', () => {
    const parsed = parseEnvFile(
      '# c\n\nA=\'x y\'\nB="z"\nC=plain\nexport D=1\nA=again\nnot a line\r\nE=\n',
    );
    expect(parsed.entries.get('A')).toMatchObject({ value: 'again', quote: 'none' });
    expect(parsed.entries.get('B')).toMatchObject({ value: 'z', quote: 'double' });
    expect(parsed.entries.get('D')?.value).toBe('1');
    expect(parsed.entries.get('E')?.value).toBe('');
    expect(parsed.duplicates).toEqual(['A']);
    expect(parsed.badLines).toEqual([8]);
  });
});

describe('template (new-env)', () => {
  it('keeps the example layout, fills generated secrets single-quoted and pre-fills known values', () => {
    const text = filledFile('production', {});
    for (const key of req()) expect(text, key).toMatch(new RegExp(`^${key}=`, 'm'));
    expect(text).toMatch(/^# REQUIRED/m);
    expect(text.indexOf('# REQUIRED')).toBeLessThan(text.indexOf('# OPTIONAL'));
    expect(text).toContain(`R2_ACCOUNT_ID='${R2_ACCOUNT_ID}'`);
    expect(text).toContain("S3_BUCKET_ASSETS='eu1prod'");
    expect(text).toContain("S3_BACKUP_BUCKET='eu-backup-prod'");
    expect(text).toContain("SHOTSTACK_ENVIRONMENT='v1'");
    expect(text).toMatch(/^BETTER_AUTH_SECRET='a{56}\d{8}'$/m);
  });

  it('staging uses the staging buckets and the smaller sizes from the example footer', () => {
    const overrides = stagingOverrides(EXAMPLE);
    expect(overrides).toMatchObject({
      STUDIO_ENV: 'staging',
      SHOTSTACK_ENVIRONMENT: 'stage',
      PROMETHEUS_HOST_PORT: '9190',
      WORKER_MEM_LIMIT: '512m',
    });
    expect(overrides).not.toHaveProperty('STUDIO_DOMAIN');
    const text = filledFile('staging');
    for (const [key, bucket] of Object.entries(BUCKETS.staging))
      expect(text).toContain(`${key}='${bucket}'`);
    expect(text).toContain("POSTGRES_MEM_LIMIT='256m'");
    expect(text).toContain("STUDIO_ENV='staging'");
  });

  it('the backup template fills only the cipher pass', () => {
    const text = renderBackupTemplate(BACKUP_EXAMPLE, 'c'.repeat(64));
    expect(text).toContain(`PG_BACKUP_CIPHER_PASS='${'c'.repeat(64)}'`);
    expect(text).toMatch(/^S3_BACKUP_ACCESS_KEY_ID=$/m);
  });
});

describe('checkEnvFile', () => {
  it('a complete file is ready; the fresh template is not', () => {
    const report = check(filledFile());
    expect(
      report.results.filter((r) => r.status === 'missing' || r.status === 'malformed'),
    ).toEqual([]);
    expect(report.ready).toBe(true);
    const fresh = renderTemplate({
      exampleText: EXAMPLE,
      env: 'production',
      values: prefillValues(EXAMPLE, 'production'),
      generatedAt: '2026-09-29',
    });
    const r = check(fresh);
    expect(r.ready).toBe(false);
    expect(r.results).toContainEqual(
      expect.objectContaining({ key: 'STRIPE_SECRET_KEY', status: 'missing' }),
    );
    expect(r.results).toContainEqual(
      expect.objectContaining({ key: 'BETTER_AUTH_SECRET', status: 'missing' }),
    );
  });

  it('never prints a value, only key names and reasons', () => {
    const text = filledFile('production', { STRIPE_SECRET_KEY: 'sk_live_%%%%' });
    const out = formatReport(check(text));
    const values = [...parseEnvFile(text).entries.values()]
      .map((e) => e.value)
      .filter((v) => v.length >= 6 && !/^(production|standalone|staging)$/.test(v));
    expect(values.length).toBeGreaterThan(20);
    for (const v of values) expect(out, 'a value leaked').not.toContain(v);
    expect(out).toContain('STRIPE_SECRET_KEY');
  });

  it.each([
    ['STRIPE_SECRET_KEY', 'pk_live_abc', 'malformed'],
    ['STRIPE_SECRET_KEY', 'rk_live_abc', 'ok'],
    ['STRIPE_WEBHOOK_SECRET', 'secret', 'malformed'],
    ['RESEND_API_KEY', 'sk_abc', 'malformed'],
    ['RESEND_WEBHOOK_SECRET', 'whsec_abc', 'ok'],
    ['STUDIO_EMAIL_FROM', 'no-reply@mail.example.com', 'ok'],
    ['STUDIO_EMAIL_FROM', 'PostMind Studio', 'malformed'],
    ['STUDIO_DOMAIN', 'https://studio.example.com', 'malformed'],
    ['R2_ACCOUNT_ID', 'not-an-id', 'malformed'],
    ['R2_JURISDICTION', 'fedramp', 'ok'],
    ['R2_JURISDICTION', 'apac', 'malformed'],
    ['S3_BUCKET_ASSETS', 'Bad_Bucket', 'malformed'],
    ['S3_BUCKET_ASSETS', 'studio1eu', 'malformed'],
    ['STUDIO_MODE', 'hybrid', 'malformed'],
    ['STUDIO_FONTS_BASE_URL', 'http://fonts.example.com', 'malformed'],
    ['POSTGRES_PASSWORD', 'short', 'malformed'],
    ['BETTER_AUTH_SECRET', 'too-short', 'malformed'],
    ['KMS_KEY_ID', 'alias/studio-envelope', 'ok'],
    ['AWS_REGION', 'London', 'malformed'],
    ['ANTHROPIC_API_KEY', '<paste here>', 'malformed'],
  ])('%s=%s → %s', (key, value, status) => {
    expect(statusOf(filledFile('production', { [key]: value }), key)).toContain(status);
  });

  it('a live Stripe key on staging is wrong; a test key on production is a reminder', () => {
    const staging = filledFile('staging', { STRIPE_SECRET_KEY: 'sk_live_abc' });
    expect(statusOf(staging, 'STRIPE_SECRET_KEY')).toContain('malformed');
    const prod = filledFile('production', { STRIPE_SECRET_KEY: 'sk_test_abc' });
    expect(statusOf(prod, 'STRIPE_SECRET_KEY')).toEqual(['ok', 'warn']);
    expect(check(prod).ready).toBe(true);
  });

  it('a secret containing $ must be single-quoted', () => {
    const text = filledFile().replace(/^RESEND_API_KEY=.*$/m, 'RESEND_API_KEY="re_ab$cd"');
    expect(statusOf(text, 'RESEND_API_KEY')).toContain('malformed');
  });

  it('a space between = and the value is wrong (compose would keep it)', () => {
    const text = filledFile().replace(/^RESEND_API_KEY=/m, 'RESEND_API_KEY= ');
    expect(statusOf(text, 'RESEND_API_KEY')).toEqual(['malformed']);
    expect(check(text).ready).toBe(false);
  });

  it('an empty R2_JURISDICTION (buckets without a jurisdiction) is a reminder, not missing', () => {
    const text = filledFile().replace(/^R2_JURISDICTION=.*$/m, 'R2_JURISDICTION=');
    expect(statusOf(text, 'R2_JURISDICTION')).toEqual(['warn']);
    expect(check(text).ready).toBe(true);
    const gone = filledFile().replace(/^R2_JURISDICTION=.*$\n/m, '');
    expect(statusOf(gone, 'R2_JURISDICTION')).toEqual(['missing']);
  });

  it('the four buckets must differ and the backup bucket must be its own', () => {
    const text = filledFile('production', {
      S3_BUCKET_RENDERS: 'eu1prod',
      S3_BACKUP_BUCKET: 'eu3prod',
    });
    const report = check(text);
    expect(report.results).toContainEqual(
      expect.objectContaining({ key: 'S3_BUCKET_*', status: 'malformed' }),
    );
    expect(report.results).toContainEqual(
      expect.objectContaining({ key: 'S3_BACKUP_BUCKET', status: 'malformed' }),
    );
  });

  it('half a Google client is wrong; Meta without a login configuration is a reminder', () => {
    const google = filledFile('production', {
      GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com',
    });
    expect(statusOf(google, 'GOOGLE_CLIENT_SECRET')).toEqual(['malformed']);
    const meta = check(filledFile());
    expect(meta.results).toContainEqual(
      expect.objectContaining({ key: 'META_LOGIN_CONFIG_ID', status: 'warn' }),
    );
  });

  it('backups on: the backup file must exist with its keys; off: not needed', () => {
    const missingBackup = check(filledFile(), null);
    expect(missingBackup.ready).toBe(false);
    const off = filledFile('production', { PG_BACKUPS: 'off' });
    expect(
      checkEnvFile({ exampleText: EXAMPLE, file: parseEnvFile(off), backup: null }).ready,
    ).toBe(true);
  });

  it('keys compose sets are flagged when an operator adds them', () => {
    const text = `${filledFile()}APP_URL='https://studio.example.com'\n`;
    expect(statusOf(text, 'APP_URL')).toEqual(['warn']);
  });
});

describe('Hive content-safety key (20.6: V2 or V3)', () => {
  const withHive = (values: Record<string, string>) =>
    filledFile('production', { HIVE_API_KEY: '', ...values });
  const hiveResults = (text: string) =>
    check(text).results.filter((r) => r.key.startsWith('HIVE_'));

  it('a V2 key alone is ready (the template default)', () => {
    const text = filledFile();
    expect(hiveResults(text)).toEqual([{ key: 'HIVE_API_KEY', status: 'ok' }]);
    expect(check(text).ready).toBe(true);
  });

  it('a V3 Secret Key alone is ready (HIVE_API_VERSION may stay empty)', () => {
    const text = withHive({ HIVE_V3_SECRET_KEY: 'fakeV3SecretKeyValue000000' });
    expect(hiveResults(text)).toEqual([{ key: 'HIVE_V3_SECRET_KEY', status: 'ok' }]);
    expect(check(text).ready).toBe(true);
  });

  it('neither key → missing, naming both', () => {
    const r = hiveResults(withHive({}));
    expect(r).toEqual([expect.objectContaining({ key: 'HIVE_API_KEY', status: 'missing' })]);
    expect(r[0]?.reason).toContain('HIVE_V3_SECRET_KEY');
    expect(check(withHive({})).ready).toBe(false);
  });

  it('HIVE_API_VERSION=v3 needs the V3 key; the unused V2 key is a reminder', () => {
    const noV3 = filledFile('production', { HIVE_API_VERSION: 'v3' });
    expect(statusOf(noV3, 'HIVE_V3_SECRET_KEY')).toEqual(['missing']);
    const both = filledFile('production', {
      HIVE_API_VERSION: 'v3',
      HIVE_V3_SECRET_KEY: 'fakeV3SecretKeyValue000000',
    });
    expect(statusOf(both, 'HIVE_V3_SECRET_KEY')).toEqual(['ok']);
    expect(statusOf(both, 'HIVE_API_KEY')).toEqual(['warn']);
    expect(check(both).ready).toBe(true);
  });

  it('a short V3 value (likely the Access Key ID) is a reminder; spaces are wrong', () => {
    expect(
      statusOf(withHive({ HIVE_V3_SECRET_KEY: 'accessKeyId0000000' }), 'HIVE_V3_SECRET_KEY'),
    ).toEqual(['ok', 'warn']);
    expect(
      statusOf(
        withHive({ HIVE_V3_SECRET_KEY: 'two words here long enough' }),
        'HIVE_V3_SECRET_KEY',
      ),
    ).toEqual(['malformed']);
    expect(
      statusOf(withHive({ HIVE_V3_SECRET_KEY: '<paste here>' }), 'HIVE_V3_SECRET_KEY'),
    ).toEqual(['malformed']);
  });

  it.each([
    ['HIVE_API_VERSION', 'v4', 'malformed'],
    ['HIVE_V3_MAX_FRAMES', '0', 'malformed'],
    ['HIVE_V3_MAX_FRAMES', '61', 'malformed'],
  ])('%s=%s → %s', (key, value, status) => {
    expect(statusOf(filledFile('production', { [key]: value }), key)).toContain(status);
  });

  it('HIVE_V3_MAX_FRAMES=20 is fine', () => {
    expect(
      statusOf(filledFile('production', { HIVE_V3_MAX_FRAMES: '20' }), 'HIVE_V3_MAX_FRAMES'),
    ).toEqual([]);
  });
});

describe('Google Veo settings (20.20)', () => {
  it('are documented in the OPTIONAL section of the server example', () => {
    const { optional, required } = exampleSections(EXAMPLE);
    for (const key of ['GOOGLE_GEMINI_API_KEY', 'VEO_MODEL', 'VEO_PERSON_GENERATION']) {
      expect(optional).toContain(key);
      expect(required).not.toContain(key);
    }
  });

  it('are optional: a file without them is ready', () => {
    expect(check(filledFile()).ready).toBe(true);
  });

  it('a well-formed key, model and person setting pass', () => {
    const text = filledFile('production', {
      GOOGLE_GEMINI_API_KEY: 'FAKE-gemini-key-0123456789abcdefghij',
      VEO_MODEL: 'veo-3.1-lite-generate-preview',
      VEO_PERSON_GENERATION: 'allow_all',
    });
    const report = check(text);
    expect(report.ready).toBe(true);
    for (const key of ['GOOGLE_GEMINI_API_KEY', 'VEO_MODEL', 'VEO_PERSON_GENERATION']) {
      expect(statusOf(text, key)).toEqual([]);
    }
  });

  it.each([
    ['GOOGLE_GEMINI_API_KEY', 'two words in the key here 0123456789'],
    ['GOOGLE_GEMINI_API_KEY', 'short'],
    ['VEO_MODEL', 'veo-2.0-generate-001'],
    ['VEO_PERSON_GENERATION', 'dont_allow'],
  ])('%s=%s is malformed', (key, value) => {
    expect(statusOf(filledFile('production', { [key]: value }), key)).toEqual(['malformed']);
  });
});
