import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// What production needs at start-up, derived from the code: every requireEnv('X') in runtime code
// (src/), plus config the code validates without requireEnv. Shared by the deployment tests
// (test/unit/render-blueprint.test.ts, test/unit/vps-compose.test.ts) so a new requireEnv fails
// both until each deployment provides it.

const ROOT = join(__dirname, '..', '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

let cache: string[] | undefined;

export function requiredAtStartup(): string[] {
  if (cache) return cache;
  const fromCode = new Set<string>();
  for (const file of tsFiles(join(ROOT, 'src'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/requireEnv\('([A-Z0-9_]+)'\)/g)) {
      fromCode.add(m[1]!);
    }
  }
  // Only for local development: NODE_ENV=production refuses it; KMS_KEY_ID is used instead
  // (src/lib/studio/crypto/envelope.ts).
  fromCode.delete('STUDIO_LOCAL_MASTER_KEY');
  const extra = [
    'DATABASE_URL', // Render: with-db-url.sh; VPS: compose.yml builds it
    'KMS_KEY_ID', // envelope.ts: without it production refuses to start encrypting
    'AWS_ACCESS_KEY_ID', // KMS credentials: no instance role on Render or the VPS
    'AWS_SECRET_ACCESS_KEY',
    'STORAGE_PROVIDER', // storage-client.ts (defaults to s3; both deployments use r2)
    'R2_ACCOUNT_ID', // storage-client.ts zod: required when STORAGE_PROVIDER=r2
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'S3_BUCKET_THUMBNAILS',
    'S3_BUCKET_LIBRARY',
    'METRICS_TOKEN', // metrics listener: Render private services and the VPS worker healthcheck
    'STUDIO_PLATFORM_ORG_IDS', // admin endpoints refused in production without it
  ];
  cache = [...new Set([...fromCode, ...extra])].sort();
  return cache;
}
