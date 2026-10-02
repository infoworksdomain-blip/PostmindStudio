import { requiredEnvForModes } from '../env';
import { studioModes, type StudioModes } from '../mode';
import {
  HIVE_V2_KEY_ENV,
  HIVE_V3_KEY_ENV,
  HIVE_VERSION_ENV,
  hiveKeyEnv,
  parseHiveV3MaxFrames,
  resolveHiveApiVersion,
} from '../studio/providers/hive-config';
import { isPersonGeneration, isVeoModel, VEO_MODELS } from '../studio/providers/veo';

// Phase 19.2 — the go-live settings file (runbooks/go-live.md): parse a server env file
// (/etc/postmind-studio/<env>.env, the format of deploy/vps/.env.example), work out which keys it
// must have, and check each one's shape. Pure functions; the CLIs are scripts/setup/new-env.ts and
// scripts/setup/check-env.ts.
//
// The required list is DERIVED, never copied, so it cannot drift:
//   - every key in the REQUIRED section of deploy/vps/.env.example (what deploy.sh expects), and
//   - requiredEnvForModes() from src/lib/env.ts (what assertStartupEnv refuses to start without),
//     minus the keys deploy/vps/compose.yml sets itself (COMPOSE_SET_KEYS).
// src/lib/setup/env-file.test.ts pins both, plus deploy.sh's preflight keys.
// 20.6: the Hive lines of the REQUIRED section are one-of: HIVE_API_KEY (V2) or HIVE_V3_SECRET_KEY
// (V3), chosen by HIVE_API_VERSION exactly as the worker chooses (providers/hive-config.ts). They
// are left out of requiredKeys() and checked by hiveChecks() instead.
//
// Reports carry key names and reasons only. No function here returns or formats a value.

export interface EnvEntry {
  value: string;
  /** How the value was written; compose interpolates `$` unless it is single-quoted. */
  quote: 'single' | 'double' | 'none';
  line: number;
  /** Whitespace between `=` and the value: compose would keep it as part of the value. */
  spaceAfterEquals: boolean;
}

export interface ParsedEnvFile {
  entries: Map<string, EnvEntry>;
  duplicates: string[];
  /** Line numbers that are neither blank, a comment nor KEY=value. */
  badLines: number[];
}

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export function parseEnvFile(text: string): ParsedEnvFile {
  const entries = new Map<string, EnvEntry>();
  const duplicates: string[] = [];
  const badLines: number[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const m = KEY_LINE.exec(raw);
    if (!m) {
      badLines.push(i + 1);
      return;
    }
    const key = m[1]!;
    const spaceAfterEquals = /^[ \t]+\S/.test(m[2]!);
    let value = m[2]!.trim();
    let quote: EnvEntry['quote'] = 'none';
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      quote = 'single';
      value = value.slice(1, -1);
    } else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      quote = 'double';
      value = value.slice(1, -1);
    }
    if (entries.has(key)) duplicates.push(key);
    entries.set(key, { value, quote, line: i + 1, spaceAfterEquals });
  });
  return { entries, duplicates, badLines };
}

/** Plain KEY → value view (for studioModes / legal readiness). Never printed. */
export function envRecord(parsed: ParsedEnvFile): Record<string, string> {
  return Object.fromEntries([...parsed.entries].map(([k, e]) => [k, e.value]));
}

/** Keys of the REQUIRED and OPTIONAL sections of deploy/vps/.env.example, in file order. */
export function exampleSections(exampleText: string): { required: string[]; optional: string[] } {
  const required: string[] = [];
  const optional: string[] = [];
  let section: 'none' | 'required' | 'optional' = 'none';
  for (const line of exampleText.split(/\r?\n/)) {
    // Section banners are "# REQUIRED — …" / "# OPTIONAL — …" (other comments mention the words).
    if (/^#\s*REQUIRED\s+[—-]/.test(line)) section = 'required';
    else if (/^#\s*OPTIONAL\s+[—-]/.test(line)) section = 'optional';
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (!m) continue;
    if (section === 'required') required.push(m[1]!);
    else if (section === 'optional') optional.push(m[1]!);
  }
  return { required, optional };
}

/** Every key the example file documents (both sections). */
export function exampleKeys(exampleText: string): string[] {
  const { required, optional } = exampleSections(exampleText);
  return [...required, ...optional];
}

/**
 * Staging overrides listed in the "STAGING on the same server" comment at the bottom of
 * deploy/vps/.env.example (KEY=value with a plain value; the domain placeholder is skipped).
 */
export function stagingOverrides(exampleText: string): Record<string, string> {
  const start = exampleText.indexOf('STAGING on the same server');
  if (start < 0) return {};
  const out: Record<string, string> = {};
  for (const m of exampleText
    .slice(start)
    .matchAll(/\b([A-Z][A-Z0-9_]*)=([A-Za-z0-9]+)(?=[\s,]|$)/g))
    out[m[1]!] = m[2]!;
  return out;
}

/** 20.6: REQUIRED-section keys where one of the set is needed (see hiveChecks). */
export const HIVE_ONE_OF_KEYS: readonly string[] = [HIVE_V2_KEY_ENV, HIVE_V3_KEY_ENV];

/** Set by deploy/vps/compose.yml from other keys; the operator never writes them. */
export const COMPOSE_SET_KEYS: readonly string[] = [
  'DATABASE_URL',
  'REDIS_URL',
  'APP_URL',
  'STUDIO_PUBLIC_CALLBACK_BASE_URL',
  'NODE_ENV',
  'SENTRY_ENVIRONMENT',
];

/** Keys of the backup env file (deploy/vps/backup.env.example) needed when PG_BACKUPS=on. */
export const BACKUP_REQUIRED_KEYS: readonly string[] = [
  'S3_BACKUP_ACCESS_KEY_ID',
  'S3_BACKUP_SECRET_ACCESS_KEY',
  'PG_BACKUP_CIPHER_PASS',
];

/** Random secrets new-env.ts generates (hex, so safe inside DATABASE_URL and compose). */
export const GENERATED_SECRET_KEYS: readonly string[] = [
  'POSTGRES_PASSWORD',
  'METRICS_TOKEN',
  'STUDIO_INTERNAL_SERVICE_TOKEN',
  'BETTER_AUTH_SECRET',
  'STUDIO_UNSUBSCRIBE_SECRET',
];

const modeKeyNames = (mode: 'standalone' | 'core') =>
  new Set(requiredEnvForModes(studioModes({ STUDIO_MODE: mode })).map((k) => k.name));

export interface RequiredKeysInput {
  exampleText: string;
  modes: StudioModes;
  studioEnv: string;
  pgBackups: boolean;
}

/** The keys this env file must set, derived from .env.example and src/lib/env.ts. */
export function requiredKeys(input: RequiredKeysInput): string[] {
  const { required } = exampleSections(input.exampleText);
  const forMode = requiredEnvForModes(input.modes).map((k) => k.name);
  const own = new Set(forMode);
  const standalone = modeKeyNames('standalone');
  const core = modeKeyNames('core');
  // A key only the other mode needs (e.g. BETTER_AUTH_SECRET in core mode) is not required.
  const otherModeOnly = new Set(
    [...(input.modes.mode === 'core' ? standalone : core)].filter((k) => !own.has(k)),
  );
  const keys = [...required, ...forMode].filter(
    (k) => !COMPOSE_SET_KEYS.includes(k) && !otherModeOnly.has(k) && !HIVE_ONE_OF_KEYS.includes(k),
  );
  // deploy.sh preflight: core mode also needs the staff organisation ids.
  if (input.modes.mode === 'core') keys.push('STUDIO_PLATFORM_ORG_IDS');
  return [...new Set(keys)].filter((k) => {
    // ACME_EMAIL is read from the PRODUCTION file only (deploy.sh).
    if (k === 'ACME_EMAIL') return input.studioEnv !== 'staging';
    if (k === 'S3_BACKUP_BUCKET') return input.pgBackups;
    return true;
  });
}

// ---- Shape checks -------------------------------------------------------------------------------

type Validator = (value: string, env: Record<string, string>) => string | null;

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const EMAIL = /^[^@\s<>"']+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
// R2 bucket names: 3-63 characters, lowercase letters, digits and hyphens, starting and ending
// with a letter or digit (https://developers.cloudflare.com/r2/buckets/create-buckets/).
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const STAGING_BUCKETS = ['studio1eu', 'eustudio2', 'eustudio3', 'eustudio4', 'eu-backup-staging'];

const minLength =
  (n: number): Validator =>
  (v) =>
    v.length >= n ? null : `must be at least ${n} characters`;

const pattern =
  (re: RegExp, reason: string): Validator =>
  (v) =>
    re.test(v) ? null : reason;

const httpsUrl: Validator = (v) => {
  try {
    return new URL(v).protocol === 'https:' ? null : 'must be an https:// address';
  } catch {
    return 'is not a valid web address';
  }
};

const positiveInt: Validator = (v) => (/^[1-9][0-9]*$/.test(v) ? null : 'must be a whole number');

const bucket: Validator = (v, env) => {
  if (!BUCKET.test(v))
    return 'is not a valid R2 bucket name (3-63 lowercase letters, digits or hyphens)';
  if (env.STUDIO_ENV === 'production' && STAGING_BUCKETS.includes(v))
    return 'is a staging bucket, but STUDIO_ENV is production';
  return null;
};

const stripeSecret: Validator = (v, env) => {
  const m = /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.exec(v);
  if (!m) return 'must start with sk_test_, sk_live_, rk_test_ or rk_live_';
  if (env.STUDIO_ENV === 'staging' && m[2] === 'live')
    return 'is a LIVE key, but STUDIO_ENV is staging (use a test/sandbox key)';
  return null;
};

const emailSender: Validator = (v) => {
  const m = /^(?:[^<>]+<([^<>]+)>|([^<>\s]+))$/.exec(v.trim());
  const address = m?.[1] ?? m?.[2];
  return address && EMAIL.test(address)
    ? null
    : "must be an address like 'PostMind Studio <no-reply@mail.example.com>'";
};

export const VALIDATORS: Readonly<Record<string, Validator>> = {
  STUDIO_ENV: (v) =>
    ['production', 'staging'].includes(v) ? null : 'must be production or staging',
  STUDIO_MODE: (v) =>
    ['', 'standalone', 'core'].includes(v) ? null : 'must be standalone or core',
  STUDIO_DOMAIN: pattern(HOST, 'must be a host name like studio.example.com (no https://, no /)'),
  ACME_EMAIL: pattern(EMAIL, 'must be an email address'),
  STUDIO_SUPPORT_EMAIL: pattern(EMAIL, 'must be an email address'),
  STUDIO_SALES_EMAIL: pattern(EMAIL, 'must be an email address'),
  STUDIO_EMAIL_REPLY_TO: pattern(EMAIL, 'must be an email address'),
  STUDIO_EMAIL_FROM: emailSender,
  POSTGRES_PASSWORD: pattern(/^[A-Za-z0-9]{16,}$/, 'must be at least 16 letters or digits'),
  METRICS_TOKEN: minLength(32),
  STUDIO_INTERNAL_SERVICE_TOKEN: minLength(32),
  STRIPE_SECRET_KEY: stripeSecret,
  STRIPE_WEBHOOK_SECRET: pattern(/^whsec_[A-Za-z0-9+/=]+$/, 'must start with whsec_'),
  STRIPE_PORTAL_CONFIGURATION_ID: pattern(/^bpc_[A-Za-z0-9]+$/, 'must start with bpc_'),
  RESEND_API_KEY: pattern(/^re_[A-Za-z0-9_]+$/, 'must start with re_'),
  RESEND_WEBHOOK_SECRET: pattern(/^whsec_[A-Za-z0-9+/=]+$/, 'must start with whsec_'),
  AWS_REGION: pattern(/^[a-z]{2}(-[a-z]+)+-[0-9]$/, 'must be an AWS region like eu-west-2'),
  AWS_ACCESS_KEY_ID: pattern(/^(AKIA|ASIA)[A-Z0-9]{16}$/, 'must be an AWS access key id (AKIA…)'),
  KMS_KEY_ID: pattern(
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|arn:aws:kms:[a-z0-9-]+:[0-9]{12}:(key\/[0-9a-f-]{36}|alias\/[A-Za-z0-9/_-]+)|alias\/[A-Za-z0-9/_-]+)$/,
    'must be a KMS key id, key ARN or alias',
  ),
  STORAGE_PROVIDER: (v) => (v === 'r2' ? null : 'must be r2 on the server'),
  R2_ACCOUNT_ID: pattern(/^[0-9a-f]{32}$/, 'must be the 32-character Cloudflare account id'),
  // Empty = buckets created without a jurisdiction (the default, global location); eu | us |
  // fedramp = buckets created in that jurisdiction. All buckets of one environment share one.
  R2_JURISDICTION: (v) =>
    ['', 'eu', 'us', 'fedramp'].includes(v)
      ? null
      : 'must be empty (no jurisdiction) or eu, us or fedramp, matching how the buckets were created',
  S3_BUCKET_ASSETS: bucket,
  S3_BUCKET_RENDERS: bucket,
  S3_BUCKET_THUMBNAILS: bucket,
  S3_BUCKET_LIBRARY: bucket,
  S3_BACKUP_BUCKET: bucket,
  STUDIO_USD_TO_GBP_RATE: (v) =>
    /^[0-9]+(\.[0-9]+)?$/.test(v) && Number(v) > 0 ? null : 'must be a positive number',
  STUDIO_FFMPEG_MAX_CONCURRENT: positiveInt,
  STUDIO_LIBRARY_CONCURRENCY: positiveInt,
  SHOTSTACK_ENVIRONMENT: (v, env) => {
    if (!['stage', 'v1'].includes(v)) return 'must be stage or v1';
    return env.STUDIO_ENV === 'staging' && v === 'v1' ? 'must be stage on staging' : null;
  },
  ASSEMBLYAI_REGION: (v) => (['eu', 'us'].includes(v) ? null : 'must be eu or us'),
  STUDIO_FONTS_BASE_URL: httpsUrl,
  GOOGLE_CLIENT_ID: pattern(
    /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/,
    'must end with .apps.googleusercontent.com',
  ),
  META_APP_ID: pattern(/^[0-9]+$/, 'must be digits only (App ID)'),
  META_LOGIN_CONFIG_ID: pattern(/^[0-9]+$/, 'must be digits only (Configuration ID)'),
  STUDIO_SIGNUPS_ENABLED: (v) => (['true', 'false'].includes(v) ? null : 'must be true or false'),
  PG_BACKUPS: (v) => (['on', 'off'].includes(v) ? null : 'must be on or off'),
  PG_BACKUP_CIPHER_PASS: minLength(32),
  // 20.20 Google Veo (Gemini API). Google does not document the key's format (standard and
  // authorization keys exist, https://ai.google.dev/gemini-api/docs/api-key), so only its shape
  // as one unbroken token is checked.
  GOOGLE_GEMINI_API_KEY: pattern(
    /^[A-Za-z0-9._-]{30,}$/,
    'must be the API key from Google AI Studio (one unbroken string, no spaces)',
  ),
  VEO_MODEL: (v) =>
    isVeoModel(v) ? null : `must be one of ${Object.keys(VEO_MODELS).join(', ')} (or empty)`,
  VEO_PERSON_GENERATION: (v) =>
    isPersonGeneration(v) ? null : 'must be allow_adult or allow_all (or empty)',
  HIVE_API_VERSION: (v) => (['v2', 'v3'].includes(v) ? null : 'must be v2 or v3 (or empty)'),
  HIVE_V3_MAX_FRAMES: (v) => {
    try {
      parseHiveV3MaxFrames(v);
      return null;
    } catch {
      return 'must be a whole number from 1 to 60';
    }
  },
};

// A value that is still an instruction instead of a setting, e.g. <paste here> or CHANGE_ME.
const PLACEHOLDER = /^<.*>$|^(changeme|change_me|todo|xxx+|placeholder)$/i;

/** Keys that are secrets: `$` inside must be single-quoted (compose interpolation). */
const SECRETISH = /(SECRET|TOKEN|PASSWORD|PASS|KEY)$/;

export type CheckStatus = 'ok' | 'missing' | 'malformed' | 'warn';

export interface CheckResult {
  key: string;
  status: CheckStatus;
  reason?: string;
}

function checkValue(
  key: string,
  entry: EnvEntry,
  record: Record<string, string>,
  min?: number,
): string | null {
  const v = entry.value.trim();
  if (entry.spaceAfterEquals) return 'has a space after = - remove it: KEY=value';
  if (PLACEHOLDER.test(v)) return 'still holds a placeholder';
  if (SECRETISH.test(key) && v.includes('$') && entry.quote !== 'single')
    return "contains $ - put the value in single quotes: KEY='value'";
  if (min && v.length < min) return `must be at least ${min} characters`;
  return VALIDATORS[key]?.(v, record) ?? null;
}

/** Required keys whose line may be present but empty, with the reminder shown for empty. */
const EMPTY_ALLOWED: ReadonlyMap<string, string> = new Map([
  [
    'R2_JURISDICTION',
    'empty: the buckets must have been created without a jurisdiction (default location, not EU-only)',
  ],
]);

export interface CheckInput {
  exampleText: string;
  file: ParsedEnvFile;
  /** The backup env file, or null when it was not found. */
  backup: ParsedEnvFile | null;
}

export interface CheckReport {
  results: CheckResult[];
  mode: string;
  ready: boolean;
}

/** Check an env file (and its backup file). ready = nothing missing or malformed. */
export function checkEnvFile(input: CheckInput): CheckReport {
  const record = envRecord(input.file);
  const results: CheckResult[] = [];
  let modes: StudioModes;
  try {
    modes = studioModes(record);
  } catch {
    results.push({ key: 'STUDIO_MODE', status: 'malformed', reason: 'must be standalone or core' });
    modes = studioModes({});
  }
  const pgBackups = (record.PG_BACKUPS ?? 'on').trim() !== 'off';
  const required = requiredKeys({
    exampleText: input.exampleText,
    modes,
    studioEnv: record.STUDIO_ENV ?? '',
    pgBackups,
  });
  const minimums = new Map(
    requiredEnvForModes(modes).map((k) => [k.name, k.minLength ?? undefined] as const),
  );

  for (const key of required) {
    const entry = input.file.entries.get(key);
    if (entry && entry.value.trim() === '' && EMPTY_ALLOWED.has(key)) {
      results.push({ key, status: 'warn', reason: EMPTY_ALLOWED.get(key)! });
      continue;
    }
    if (!entry || entry.value.trim() === '') {
      results.push({ key, status: 'missing', reason: 'required, not set' });
      continue;
    }
    const reason = checkValue(key, entry, record, minimums.get(key));
    results.push(reason ? { key, status: 'malformed', reason } : { key, status: 'ok' });
  }

  // Optional keys: checked only when set.
  const requiredSet = new Set(required);
  for (const [key, entry] of input.file.entries) {
    if (requiredSet.has(key) || entry.value.trim() === '') continue;
    if (key === HIVE_V2_KEY_ENV || key === HIVE_V3_KEY_ENV) continue; // hiveChecks

    const reason = checkValue(key, entry, record);
    if (reason) results.push({ key, status: 'malformed', reason });
  }

  results.push(...hiveChecks(input.file, record), ...pairChecks(record), ...crossChecks(record));
  for (const key of input.file.duplicates)
    results.push({ key, status: 'warn', reason: 'is set more than once; the last line wins' });
  for (const line of input.file.badLines)
    results.push({ key: `line ${line}`, status: 'malformed', reason: 'is not KEY=value' });
  for (const key of COMPOSE_SET_KEYS)
    if (input.file.entries.has(key))
      results.push({ key, status: 'warn', reason: 'is set by compose.yml; remove it here' });

  if (pgBackups) results.push(...backupChecks(input.backup));
  return {
    results,
    mode: modes.mode,
    ready: !results.some((r) => r.status === 'missing' || r.status === 'malformed'),
  };
}

function isSet(record: Record<string, string>, key: string): boolean {
  return (record[key] ?? '').trim() !== '';
}

/** Settings that only work together: all set or all empty. */
const GROUPS: ReadonlyArray<{ keys: string[]; what: string; status: CheckStatus }> = [
  // Half a Google client breaks the sign-in button: wrong.
  {
    keys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    what: 'Google sign-in',
    status: 'malformed',
  },
  // Meta app id/secret are required for publishing anyway; without the configuration id the
  // "Connect with Facebook" button just stays hidden (runbooks/meta-connect.md): a reminder.
  {
    keys: ['META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID'],
    what: '"Connect with Facebook"',
    status: 'warn',
  },
];

function pairChecks(record: Record<string, string>): CheckResult[] {
  return GROUPS.flatMap(({ keys, what, status }) => {
    const set = keys.filter((k) => isSet(record, k));
    if (set.length === 0 || set.length === keys.length) return [];
    return keys
      .filter((k) => !isSet(record, k))
      .map((key) => ({ key, status, reason: `${what} needs ${keys.join(', ')} together` }));
  });
}

/** A V3 Secret Key shorter than this is probably the Access Key ID pasted by mistake. */
const HIVE_V3_SECRET_MIN_LENGTH = 20;

/**
 * 20.6: content safety needs ONE Hive key: the one HIVE_API_VERSION selects (empty = v3 when only
 * HIVE_V3_SECRET_KEY is set, else v2). The same rule as the worker (hive-config.ts).
 */
function hiveChecks(file: ParsedEnvFile, record: Record<string, string>): CheckResult[] {
  let version;
  try {
    version = resolveHiveApiVersion(record);
  } catch {
    return []; // HIVE_API_VERSION itself is reported by its validator.
  }
  const key = hiveKeyEnv(version);
  const entry = file.entries.get(key);
  if (!entry || entry.value.trim() === '') {
    return [
      {
        key,
        status: 'missing',
        reason: `content safety needs ${HIVE_V2_KEY_ENV} (Hive V2) or ${HIVE_V3_KEY_ENV} (Hive V3); ${HIVE_VERSION_ENV} selects ${version}`,
      },
    ];
  }
  const reason = checkValue(key, entry, record);
  if (reason) return [{ key, status: 'malformed', reason }];
  const value = entry.value.trim();
  if (/\s/.test(value)) return [{ key, status: 'malformed', reason: 'must not contain spaces' }];
  const out: CheckResult[] = [{ key, status: 'ok' }];
  if (version === 'v3' && value.length < HIVE_V3_SECRET_MIN_LENGTH)
    out.push({
      key,
      status: 'warn',
      reason:
        'is short for a V3 Secret Key: check you pasted the "Secret Key" column, not the "Access Key ID"',
    });
  const other = version === 'v3' ? HIVE_V2_KEY_ENV : HIVE_V3_KEY_ENV;
  if (isSet(record, other))
    out.push({
      key: other,
      status: 'warn',
      reason: `is set but not used: ${HIVE_VERSION_ENV} selects ${version} (${key})`,
    });
  return out;
}

function crossChecks(record: Record<string, string>): CheckResult[] {
  const out: CheckResult[] = [];
  const buckets = [
    'S3_BUCKET_ASSETS',
    'S3_BUCKET_RENDERS',
    'S3_BUCKET_THUMBNAILS',
    'S3_BUCKET_LIBRARY',
  ];
  const live = buckets.map((k) => record[k]?.trim() ?? '').filter(Boolean);
  if (new Set(live).size !== live.length)
    out.push({
      key: 'S3_BUCKET_*',
      status: 'malformed',
      reason: 'the four buckets must be different',
    });
  const backupBucket = record.S3_BACKUP_BUCKET?.trim();
  if (backupBucket && live.includes(backupBucket))
    out.push({
      key: 'S3_BACKUP_BUCKET',
      status: 'malformed',
      reason: 'must be its own bucket, not one of the four live buckets',
    });
  const stripe = /^(?:sk|rk)_(test|live)_/.exec(record.STRIPE_SECRET_KEY ?? '');
  if (stripe?.[1] === 'test' && record.STUDIO_ENV === 'production')
    out.push({
      key: 'STRIPE_SECRET_KEY',
      status: 'warn',
      reason:
        'is a test/sandbox key on production: fine while testing; switch key AND webhook secret to live mode together before launch',
    });
  if (stripe && isSet(record, 'STRIPE_WEBHOOK_SECRET'))
    out.push({
      key: 'STRIPE_WEBHOOK_SECRET',
      status: 'warn',
      reason: `a whsec_ secret does not say which mode made it: check it belongs to the ${stripe[1]} mode endpoint, like the secret key`,
    });
  return out;
}

function backupChecks(backup: ParsedEnvFile | null): CheckResult[] {
  if (!backup)
    return BACKUP_REQUIRED_KEYS.map((key) => ({
      key,
      status: 'missing' as const,
      reason: 'backup env file not found (<env>.backup.env next to this file, or --backup)',
    }));
  const record = envRecord(backup);
  return BACKUP_REQUIRED_KEYS.map((key): CheckResult => {
    const entry = backup.entries.get(key);
    if (!entry || entry.value.trim() === '')
      return { key, status: 'missing', reason: 'required in the backup env file' };
    const reason = checkValue(key, entry, record);
    return reason ? { key, status: 'malformed', reason } : { key, status: 'ok' };
  });
}

const LABEL: Record<CheckStatus, string> = {
  ok: 'OK',
  missing: 'MISSING',
  malformed: 'WRONG',
  warn: 'CHECK',
};

/** The printable report: status, key name and reason. Never a value. */
export function formatReport(report: CheckReport): string {
  const order: CheckStatus[] = ['missing', 'malformed', 'warn', 'ok'];
  const rows = [...report.results].sort(
    (a, b) => order.indexOf(a.status) - order.indexOf(b.status),
  );
  const lines = rows.map(
    (r) => `${LABEL[r.status].padEnd(8)} ${r.key}${r.reason ? `  - ${r.reason}` : ''}`,
  );
  const count = (s: CheckStatus) => report.results.filter((r) => r.status === s).length;
  lines.push(
    '',
    `Mode: ${report.mode}. ${count('ok')} OK, ${count('missing')} missing, ${count('malformed')} wrong, ${count('warn')} to check.`,
    report.ready
      ? 'READY: every required setting is present and looks right.'
      : 'NOT READY: fix the MISSING and WRONG lines above.',
  );
  return `${lines.join('\n')}\n`;
}

// ---- Template -----------------------------------------------------------------------------------

/** R2 account id of the operator's Cloudflare account (not a secret: it is in every R2 URL). */
export const R2_ACCOUNT_ID = '1ec9cdb965c538b74ce6dd16831dd819';

export const BUCKETS: Record<'production' | 'staging', Record<string, string>> = {
  production: {
    S3_BUCKET_ASSETS: 'eu1prod',
    S3_BUCKET_RENDERS: 'eu2prod',
    S3_BUCKET_THUMBNAILS: 'eu3prod',
    S3_BUCKET_LIBRARY: 'eu4prod',
    S3_BACKUP_BUCKET: 'eu-backup-prod',
  },
  staging: {
    S3_BUCKET_ASSETS: 'studio1eu',
    S3_BUCKET_RENDERS: 'eustudio2',
    S3_BUCKET_THUMBNAILS: 'eustudio3',
    S3_BUCKET_LIBRARY: 'eustudio4',
    S3_BACKUP_BUCKET: 'eu-backup-staging',
  },
};

export interface TemplateInput {
  exampleText: string;
  env: 'production' | 'staging';
  /** Generated secrets and any other prefilled values. */
  values: Record<string, string>;
  generatedAt: string;
}

/** Values new-env.ts fills in besides the generated secrets. */
export function prefillValues(
  exampleText: string,
  env: 'production' | 'staging',
  domain?: string,
): Record<string, string> {
  return {
    ...(env === 'staging' ? stagingOverrides(exampleText) : {}),
    STUDIO_ENV: env,
    STUDIO_MODE: 'standalone',
    R2_ACCOUNT_ID,
    ...BUCKETS[env],
    SHOTSTACK_ENVIRONMENT: env === 'production' ? 'v1' : 'stage',
    ...(domain ? { STUDIO_DOMAIN: domain } : {}),
  };
}

function quoted(value: string): string {
  return `'${value}'`;
}

/** deploy/vps/.env.example with the given values filled in (single-quoted) and a header. */
export function renderTemplate(input: TemplateInput): string {
  const header = [
    '# =================================================================================================',
    `# PostMind Studio - ${input.env} settings, made by scripts/setup/new-env.ts on ${input.generatedAt}`,
    '# =================================================================================================',
    `# Server path: /etc/postmind-studio/${input.env}.env (chmod 600). Fill in every empty REQUIRED`,
    '# line, following runbooks/go-live.md, then check it:  npm run setup:check -- <this file>',
    `# The random secrets below were generated for you. Keep a copy in the password manager, and`,
    '# delete this file from your laptop once it is on the server.',
    '',
  ];
  const body = input.exampleText.split(/\r?\n/).map((line) => {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) return line;
    const key = m[1]!;
    const value = input.values[key];
    if (value === undefined) return line;
    return `${key}=${quoted(value)}`;
  });
  return `${[...header, ...body].join('\n').replace(/\n*$/, '')}\n`;
}

/** The backup env file (deploy/vps/backup.env.example) with the cipher pass filled in. */
export function renderBackupTemplate(backupExampleText: string, cipherPass: string): string {
  return `${backupExampleText
    .split(/\r?\n/)
    .map((line) =>
      line.startsWith('PG_BACKUP_CIPHER_PASS=')
        ? `PG_BACKUP_CIPHER_PASS=${quoted(cipherPass)}`
        : line,
    )
    .join('\n')
    .replace(/\n*$/, '')}\n`;
}
