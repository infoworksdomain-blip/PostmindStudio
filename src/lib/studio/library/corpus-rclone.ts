import { ValidationError } from '../../errors';

// Phase 19 Track 1 — the rclone remote for uploading the corpus to Cloudflare R2
// (scripts/corpus/rclone-config.ts, runbooks/corpus-upload.md). Pure; unit tested.
//
// Sources (read 2026-09-29):
// - https://rclone.org/s3/#cloudflare-r2 — type = s3, provider = Cloudflare, region = auto,
//   acl = private, endpoint https://ACCOUNT_ID.r2.cloudflarestorage.com, and "For R2 tokens with
//   the 'Object Read & Write' permission, you may also need to add no_check_bucket = true".
// - https://developers.cloudflare.com/r2/api/tokens/ — jurisdiction buckets are reached through
//   https://<ACCOUNT_ID>.<jurisdiction>.r2.cloudflarestorage.com (eu, fedramp, us).

export const CORPUS_REMOTE = 'postmind-corpus';
export const R2_JURISDICTIONS = ['eu', 'fedramp', 'us'] as const;

export const ENV_NAMES = {
  accessKeyId: 'CORPUS_R2_ACCESS_KEY_ID',
  secretAccessKey: 'CORPUS_R2_SECRET_ACCESS_KEY',
  accountId: 'R2_ACCOUNT_ID',
  jurisdiction: 'R2_JURISDICTION',
} as const;

export interface CorpusR2Settings {
  accessKeyId: string;
  secretAccessKey: string;
  accountId: string;
  /** '' for a bucket created without a jurisdiction. */
  jurisdiction: string;
}

/** Parses KEY=VALUE lines (# comments, blank lines, optional surrounding quotes). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** Environment first (when set and non-empty), then the env file. */
export function mergeSettingsSources(
  env: Readonly<Record<string, string | undefined>>,
  file: Readonly<Record<string, string>>,
): {
  values: Record<string, string>;
  sources: Record<string, 'environment' | 'env file' | 'missing'>;
} {
  const values: Record<string, string> = {};
  const sources: Record<string, 'environment' | 'env file' | 'missing'> = {};
  for (const name of Object.values(ENV_NAMES)) {
    const fromEnv = env[name]?.trim();
    const fromFile = file[name]?.trim();
    if (fromEnv) {
      values[name] = fromEnv;
      sources[name] = 'environment';
    } else if (fromFile) {
      values[name] = fromFile;
      sources[name] = 'env file';
    } else sources[name] = 'missing';
  }
  return { values, sources };
}

/**
 * Validates the settings. Error messages name the setting, never its value. The secret must be
 * 64 hex characters (Cloudflare: "Secret Access Key: The SHA-256 hash of the API token value");
 * the key ID letters and digits only. Anything else is most likely a paste of the wrong field.
 */
export function validateSettings(values: Readonly<Record<string, string>>): CorpusR2Settings {
  const missing = [ENV_NAMES.accessKeyId, ENV_NAMES.secretAccessKey, ENV_NAMES.accountId].filter(
    (n) => !values[n],
  );
  if (missing.length > 0)
    throw new ValidationError(`Missing ${missing.join(', ')}: fill them in the env file`);
  const accessKeyId = values[ENV_NAMES.accessKeyId] as string;
  const secretAccessKey = values[ENV_NAMES.secretAccessKey] as string;
  const accountId = values[ENV_NAMES.accountId] as string;
  const jurisdiction = (values[ENV_NAMES.jurisdiction] ?? '').toLowerCase();
  if (!/^[0-9a-f]{32}$/i.test(accountId))
    throw new ValidationError(
      `${ENV_NAMES.accountId} must be the 32-character Cloudflare account ID`,
    );
  if (jurisdiction && !(R2_JURISDICTIONS as readonly string[]).includes(jurisdiction))
    throw new ValidationError(
      `${ENV_NAMES.jurisdiction} must be empty or one of ${R2_JURISDICTIONS.join(', ')}`,
    );
  if (!/^[A-Za-z0-9]{16,128}$/.test(accessKeyId))
    throw new ValidationError(
      `${ENV_NAMES.accessKeyId} is not an R2 Access Key ID (letters and digits only): check you pasted the "Access Key ID" value`,
    );
  if (!/^[0-9a-f]{64}$/i.test(secretAccessKey))
    throw new ValidationError(
      `${ENV_NAMES.secretAccessKey} is not an R2 Secret Access Key (64 letters and digits): check you pasted the "Secret Access Key" value`,
    );
  return { accessKeyId, secretAccessKey, accountId: accountId.toLowerCase(), jurisdiction };
}

export function r2Endpoint(accountId: string, jurisdiction: string): string {
  return jurisdiction
    ? `https://${accountId}.${jurisdiction}.r2.cloudflarestorage.com`
    : `https://${accountId}.r2.cloudflarestorage.com`;
}

/** The rclone config file (INI) with one remote. Holds the secret: write it outside the repo. */
export function renderRcloneConfig(settings: CorpusR2Settings, remote = CORPUS_REMOTE): string {
  if (!/^[A-Za-z0-9_-]+$/.test(remote)) throw new ValidationError('Invalid rclone remote name');
  return [
    '# Written by scripts/corpus/rclone-config.ts (runbooks/corpus-upload.md). Contains a secret:',
    '# keep it private and delete it when the corpus upload is finished.',
    `[${remote}]`,
    'type = s3',
    'provider = Cloudflare',
    `access_key_id = ${settings.accessKeyId}`,
    `secret_access_key = ${settings.secretAccessKey}`,
    'region = auto',
    `endpoint = ${r2Endpoint(settings.accountId, settings.jurisdiction)}`,
    'acl = private',
    'no_check_bucket = true',
    '',
  ].join('\n');
}

/** The env file the operator fills in with Notepad (placeholders only). */
export function envFileTemplate(
  defaults: { accountId?: string; jurisdiction?: string } = {},
): string {
  return [
    '# PostMind corpus upload: the Cloudflare R2 key for the eu-corpus-source bucket.',
    '# Paste each value straight after the = sign. No spaces and no quote marks.',
    '# Save the file (Ctrl+S) and close Notepad. Never email or share this file.',
    `${ENV_NAMES.accessKeyId}=`,
    `${ENV_NAMES.secretAccessKey}=`,
    '',
    '# Filled in by your engineer (not secret):',
    `${ENV_NAMES.accountId}=${defaults.accountId ?? ''}`,
    `${ENV_NAMES.jurisdiction}=${defaults.jurisdiction ?? 'eu'}`,
    '',
  ].join('\r\n');
}

/** "ab12…ef90": enough to tell two keys apart, never the whole value. */
export function maskKeyId(value: string): string {
  return value.length <= 8 ? '…' : `${value.slice(0, 4)}…${value.slice(-4)}`;
}
