import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ValidationError } from '../../src/lib/errors';
import { failCli, isInside, parseArgs } from '../../src/lib/studio/library/corpus-cli-args';
import {
  CORPUS_REMOTE,
  ENV_NAMES,
  envFileTemplate,
  maskKeyId,
  mergeSettingsSources,
  parseEnvFile,
  r2Endpoint,
  renderRcloneConfig,
  validateSettings,
} from '../../src/lib/studio/library/corpus-rclone';

// Phase 19 Track 1 — write the rclone remote for the corpus upload (runbooks/corpus-upload.md).
//
//   npm run corpus:rclone-config -- --init [--account-id <id>]   writes the env file template
//   npm run corpus:rclone-config                                 writes the rclone config
//     [--env-path %USERPROFILE%\postmind-corpus.env]
//     [--conf %USERPROFILE%\.config\rclone\postmind-corpus.conf] [--remote postmind-corpus]
//
// Reads CORPUS_R2_ACCESS_KEY_ID, CORPUS_R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID and R2_JURISDICTION
// from the environment, else from the env file. The secret is written to the config file only:
// it is never printed. Both files must live outside the repository.

const REPO_ROOT = resolve(__dirname, '..', '..');

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function assertOutsideRepo(path: string, what: string): void {
  if (isInside(REPO_ROOT, path))
    throw new ValidationError(
      `The ${what} holds a secret: put it outside the repository (${REPO_ROOT})`,
    );
}

function writeTemplate(envFile: string, accountId: string | undefined): boolean {
  if (existsSync(envFile)) return false;
  mkdirSync(dirname(envFile), { recursive: true });
  writeFileSync(envFile, envFileTemplate({ accountId }), { mode: 0o600 });
  return true;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2), {
    valueOptions: ['--env-path', '--conf', '--remote', '--account-id'],
    flagOptions: ['--init'],
  });
  if (args.positional.length > 0)
    throw new ValidationError(`unexpected argument ${args.positional[0]}`);
  const envFile = resolve(args.values.get('--env-path') ?? join(homedir(), 'postmind-corpus.env'));
  const confPath = resolve(
    args.values.get('--conf') ?? join(homedir(), '.config', 'rclone', 'postmind-corpus.conf'),
  );
  const remote = args.values.get('--remote') ?? CORPUS_REMOTE;
  assertOutsideRepo(envFile, 'env file');
  assertOutsideRepo(confPath, 'rclone config');

  const accountId = args.values.get('--account-id') ?? process.env[ENV_NAMES.accountId]?.trim();
  if (args.flags.has('--init') || !existsSync(envFile)) {
    const created = writeTemplate(envFile, accountId || undefined);
    out(
      created
        ? `Created ${envFile}.\nOpen it with Notepad (notepad "${envFile}"), paste the two R2 key values after the = signs, save, then run this command again without --init.`
        : `${envFile} already exists: left unchanged.`,
    );
    if (!args.flags.has('--init')) process.exitCode = 1;
    return;
  }

  const { values, sources } = mergeSettingsSources(
    process.env,
    parseEnvFile(readFileSync(envFile, 'utf8')),
  );
  const settings = validateSettings(values);
  mkdirSync(dirname(confPath), { recursive: true });
  writeFileSync(confPath, renderRcloneConfig(settings, remote), { mode: 0o600 });
  out(`Wrote the rclone config: ${confPath}`);
  out(`  remote:        ${remote}`);
  out(`  endpoint:      ${r2Endpoint(settings.accountId, settings.jurisdiction)}`);
  out(
    `  access key ID: ${maskKeyId(settings.accessKeyId)} (from the ${sources[ENV_NAMES.accessKeyId]})`,
  );
  out(
    `  secret:        written to the config file only (from the ${sources[ENV_NAMES.secretAccessKey]})`,
  );
  out(`Test it: rclone lsf --config "${confPath}" ${remote}:eu-corpus-source`);
}

try {
  main();
} catch (err: unknown) {
  failCli('rclone-config', err);
}
