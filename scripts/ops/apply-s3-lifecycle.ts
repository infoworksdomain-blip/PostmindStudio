import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  type S3Client,
  type LifecycleRule as S3LifecycleRule,
} from '@aws-sdk/client-s3';
import { ValidationError } from '../../src/lib/errors';
import { logger } from '../../src/lib/logger';
import {
  diffBucket,
  formatDiff,
  isNoop,
  lifecycleFileFor,
  LOGICAL_BUCKETS,
  parseLifecycleFile,
  type LogicalBucket,
} from '../../src/lib/studio/ops/s3-lifecycle';
import { createStorageS3Client, storageProvider } from '../../src/lib/studio/storage-client';

// BACKLOG 14.2 — apply infra/s3-lifecycle.json to Studio's S3 buckets. DevOps runs it with the
// production credentials (s3:GetLifecycleConfiguration + s3:PutLifecycleConfiguration):
//
//   AWS_REGION=eu-west-2 S3_BUCKET_ASSETS=... S3_BUCKET_RENDERS=... S3_BUCKET_THUMBNAILS=... \
//   S3_BUCKET_LIBRARY=... npx tsx scripts/ops/apply-s3-lifecycle.ts            # dry run: diff
//   ... npx tsx scripts/ops/apply-s3-lifecycle.ts --apply                      # write, re-read
//   ... [--only assets,library] [--config infra/s3-lifecycle.json]
//
// Dry run by default. PutBucketLifecycleConfiguration REPLACES a bucket's whole configuration,
// so rules whose ID does not start with "studio-" are read first and written back unchanged.
// A bucket whose env var is unset is skipped (reported). AWS SDK v3:
//   GetBucketLifecycleConfiguration (NoSuchLifecycleConfiguration when none)
//   https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetBucketLifecycleConfiguration.html
//   PutBucketLifecycleConfiguration
//   https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketLifecycleConfiguration.html
//
// Storage: Cloudflare R2 — with STORAGE_PROVIDER=r2 the default file is infra/r2-lifecycle.json
// and the client comes from the storage factory (storage-client.ts: R2 endpoint, R2_* keys). R2
// implements Get/PutBucketLifecycleConfiguration, but managing lifecycles is a bucket-level
// action: run this with the keys of an Admin Read & Write R2 token in R2_ACCESS_KEY_ID /
// R2_SECRET_ACCESS_KEY (the app's Object Read & Write token cannot change bucket configuration):
// https://developers.cloudflare.com/r2/buckets/object-lifecycles/ and runbooks/r2-setup.md.
//
//   STORAGE_PROVIDER=r2 R2_ACCOUNT_ID=... R2_JURISDICTION=eu R2_ACCESS_KEY_ID=<admin> //   R2_SECRET_ACCESS_KEY=<admin> S3_BUCKET_ASSETS=... npx tsx scripts/ops/apply-s3-lifecycle.ts

interface Args {
  apply: boolean;
  only?: LogicalBucket[];
  config: string;
}

/** The default --config follows STORAGE_PROVIDER (lifecycleFileFor). */
function parseArgs(argv: string[], defaultConfig: string): Args {
  const args: Args = { apply: false, config: defaultConfig };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--apply') args.apply = true;
    else if (flag === '--only' || flag === '--config') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new ValidationError(`${flag} needs a value`);
      i += 1;
      if (flag === '--config') args.config = value;
      else {
        const names = value.split(',').map((s) => s.trim());
        const unknown = names.filter((n) => !(LOGICAL_BUCKETS as readonly string[]).includes(n));
        if (unknown.length) throw new ValidationError(`unknown bucket(s): ${unknown.join(', ')}`);
        args.only = names as LogicalBucket[];
      }
    } else throw new ValidationError(`unknown option ${flag}`);
  }
  return args;
}

async function currentRules(client: S3Client, bucket: string): Promise<S3LifecycleRule[]> {
  try {
    const out = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
    return out.Rules ?? [];
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchLifecycleConfiguration') return [];
    throw err;
  }
}

async function main(): Promise<void> {
  const provider = storageProvider();
  const args = parseArgs(process.argv.slice(2), lifecycleFileFor(provider));
  const client = createStorageS3Client();
  const file = parseLifecycleFile(JSON.parse(readFileSync(resolve(args.config), 'utf8')), provider);
  process.stdout.write(`Storage provider: ${provider}; rules from ${args.config}
`);
  let failed = false;
  for (const logical of args.only ?? LOGICAL_BUCKETS) {
    const entry = file.buckets[logical];
    if (!entry) continue;
    const bucket = process.env[entry.envVar]?.trim();
    if (!bucket) {
      process.stdout.write(`${logical}: skipped (${entry.envVar} is not set)\n`);
      continue;
    }
    const diff = diffBucket(await currentRules(client, bucket), entry.rules);
    process.stdout.write(`${formatDiff(logical, bucket, diff)}\n`);
    if (!args.apply || isNoop(diff)) continue;
    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: { Rules: diff.next as S3LifecycleRule[] },
      }),
    );
    const verify = diffBucket(await currentRules(client, bucket), entry.rules);
    if (isNoop(verify)) process.stdout.write(`  applied and verified\n`);
    else {
      failed = true;
      process.stdout.write(
        `  APPLIED BUT DIFFERS on re-read:\n${formatDiff(logical, bucket, verify)}\n`,
      );
    }
  }
  if (!args.apply) process.stdout.write('\nDry run: nothing written. Re-run with --apply.\n');
  if (failed) process.exitCode = 1;
}

main().catch((err: unknown) => {
  logger.error({ err }, 'apply-s3-lifecycle failed');
  process.exitCode = 1;
});
