import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { QUEUES } from '../../src/lib/studio/queue/queues';

// Deployment: Render — render.yaml checked against the code and runbooks/render-deploy.md.

const ROOT = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

type EnvVar = {
  key?: string;
  value?: unknown;
  generateValue?: boolean;
  sync?: boolean;
  fromGroup?: string;
  fromDatabase?: { name: string; property: string };
  fromService?: { name: string; type: string; property?: string; envVarKey?: string };
};
type Service = {
  name: string;
  type: string;
  runtime?: string;
  region?: string;
  plan?: string;
  dockerCommand?: string;
  dockerfilePath?: string;
  preDeployCommand?: string;
  healthCheckPath?: string;
  autoDeployTrigger?: string;
  maxShutdownDelaySeconds?: number;
  numInstances?: number;
  maxmemoryPolicy?: string;
  persistenceMode?: string;
  ipAllowList?: unknown[];
  schedule?: string;
  envVars?: EnvVar[];
};
type Database = {
  name: string;
  region?: string;
  postgresMajorVersion?: string;
  ipAllowList?: unknown[];
};
type Group = { name: string; envVars: EnvVar[] };
type Environment = {
  name: string;
  services: Service[];
  databases: Database[];
  envVarGroups: Group[];
};
type Blueprint = {
  services?: unknown;
  databases?: unknown;
  envVarGroups?: unknown;
  projects: Array<{ name: string; environments: Environment[] }>;
};

const blueprint = load(read('render.yaml')) as Blueprint;
const environments = blueprint.projects.flatMap((p) => p.environments);
const ENV_NAMES = ['staging', 'production'] as const;
const env = (name: string) => environments.find((e) => e.name === name)!;
const allServices = environments.flatMap((e) => e.services);
const allDatabases = environments.flatMap((e) => e.databases);
const allGroups = environments.flatMap((e) => e.envVarGroups);

const WRAPPER = 'sh scripts/render/with-db-url.sh ';
const isAppService = (s: Service) =>
  s.dockerCommand?.startsWith(WRAPPER) === true && s.type !== 'keyvalue';
const appServices = (e: Environment) => e.services.filter(isAppService);
const keysOf = (vars: EnvVar[]) => vars.flatMap((v) => (v.key ? [v.key] : []));

/** Every env var key a service gets: its own plus those of every linked group. */
function providedKeys(e: Environment, service: Service): Set<string> {
  const vars = service.envVars ?? [];
  const groups = vars.flatMap((v) => (v.fromGroup ? [v.fromGroup] : []));
  const fromGroups = groups.flatMap((g) => {
    const group = e.envVarGroups.find((x) => x.name === g);
    return group ? keysOf(group.envVars) : [];
  });
  return new Set([...keysOf(vars), ...fromGroups]);
}

/** Keys the operator pastes into studio-secrets-<env> (runbooks/render-deploy.md table). */
function operatorKeys(envName: string): Set<string> {
  const doc = read('runbooks/render-deploy.md');
  const block = doc
    .split('<!-- render-operator-env:start -->')[1]
    ?.split('<!-- render-operator-env:end -->')[0];
  if (!block) throw new Error('operator env table markers missing');
  const keys = [...block.matchAll(/^\| `([A-Z0-9_]+)` \| (both|staging|production) \|/gm)]
    .filter((m) => m[2] === 'both' || m[2] === envName)
    .map((m) => m[1]!);
  return new Set(keys);
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/**
 * What production needs at start-up: every requireEnv('X') in runtime code (src/), plus config the
 * code validates without requireEnv. Derived from the code so a new requireEnv fails this test
 * until render.yaml or the runbook provides it.
 */
let requiredCache: string[] | undefined;
function requiredAtStartup(): string[] {
  if (requiredCache) return requiredCache;
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
    'DATABASE_URL', // built by with-db-url.sh from RENDER_POSTGRES_URL
    'KMS_KEY_ID', // envelope.ts: without it production refuses to start encrypting
    'AWS_ACCESS_KEY_ID', // KMS credentials: no instance role on Render
    'AWS_SECRET_ACCESS_KEY',
    'STORAGE_PROVIDER', // storage-client.ts (defaults to s3; Render uses r2)
    'R2_ACCOUNT_ID', // storage-client.ts zod: required when STORAGE_PROVIDER=r2
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'S3_BUCKET_THUMBNAILS',
    'S3_BUCKET_LIBRARY',
    'METRICS_TOKEN', // metrics listener = the port a private service must open
    'STUDIO_PLATFORM_ORG_IDS', // admin endpoints refused in production without it
  ];
  requiredCache = [...new Set([...fromCode, ...extra])].sort();
  return requiredCache;
}

describe('render.yaml — structure', () => {
  it('defines everything inside one project with staging and production environments', () => {
    expect(blueprint.services).toBeUndefined();
    expect(blueprint.databases).toBeUndefined();
    expect(blueprint.envVarGroups).toBeUndefined();
    expect(blueprint.projects).toHaveLength(1);
    expect(environments.map((e) => e.name)).toEqual([...ENV_NAMES]);
  });

  it('uses unique names across the whole file', () => {
    const names = [...allServices, ...allDatabases, ...allGroups].map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('suffixes every resource with its environment', () => {
    for (const e of environments) {
      for (const r of [...e.services, ...e.databases, ...e.envVarGroups]) {
        expect(r.name.endsWith(`-${e.name}`), r.name).toBe(true);
      }
    }
  });

  it('runs every service and database in frankfurt', () => {
    for (const r of [...allServices, ...allDatabases]) expect(r.region, r.name).toBe('frankfurt');
  });

  it('keeps every reference inside its own environment', () => {
    for (const e of environments) {
      const names = new Set([...e.services, ...e.databases, ...e.envVarGroups].map((r) => r.name));
      for (const v of e.services.flatMap((s) => s.envVars ?? [])) {
        const ref = v.fromGroup ?? v.fromDatabase?.name ?? v.fromService?.name;
        if (ref) expect(names.has(ref), `${ref} in ${e.name}`).toBe(true);
      }
    }
  });
});

describe('render.yaml — datastores', () => {
  it.each(ENV_NAMES)('%s: Postgres is pinned to a pgvector-capable major and private', (name) => {
    const [db, ...more] = env(name).databases;
    expect(more).toHaveLength(0);
    // pgvector: PostgreSQL 13+ on Render (https://render.com/docs/postgresql-extensions).
    expect(db!.postgresMajorVersion).toMatch(/^\d+$/);
    expect(Number(db!.postgresMajorVersion)).toBeGreaterThanOrEqual(13);
    expect(db!.ipAllowList).toEqual([]);
  });

  it.each(ENV_NAMES)(
    '%s: Key Value is noeviction, persistent and has no external access',
    (name) => {
      const kv = env(name).services.filter((s) => s.type === 'keyvalue');
      expect(kv).toHaveLength(1);
      expect(kv[0]).toMatchObject({ maxmemoryPolicy: 'noeviction', ipAllowList: [] });
      expect(kv[0]!.persistenceMode).not.toBe('off');
      expect(kv[0]!.plan).not.toBe('free'); // free instances have no persistence
    },
  );
});

describe('render.yaml — app services', () => {
  it.each(ENV_NAMES)('%s: one private service per worker queue', (name) => {
    const e = env(name);
    for (const queue of Object.values(QUEUES)) {
      const workers = e.services.filter((s) =>
        s.dockerCommand?.endsWith(`npx tsx scripts/worker.ts ${queue}`),
      );
      expect(workers, queue).toHaveLength(1);
      // pserv, not worker: background workers cannot receive the Prometheus scrape.
      expect(workers[0]!.type).toBe('pserv');
      expect(workers[0]!.maxShutdownDelaySeconds).toBeGreaterThanOrEqual(1);
      expect(workers[0]!.maxShutdownDelaySeconds).toBeLessThanOrEqual(300);
    }
    expect(e.services.filter((s) => s.type === 'worker')).toHaveLength(0);
  });

  it.each(ENV_NAMES)('%s: the web service migrates before every deploy', (name) => {
    const web = env(name).services.filter((s) => s.type === 'web');
    expect(web).toHaveLength(1);
    expect(web[0]).toMatchObject({
      runtime: 'docker',
      dockerCommand: `${WRAPPER}npx next start -p 3010`,
      preDeployCommand: `${WRAPPER}sh scripts/render/migrate.sh`,
      healthCheckPath: '/api/health/ready',
    });
    const migrate = read('scripts/render/migrate.sh');
    expect(migrate).toMatch(/^npx --no-install prisma migrate deploy$/m);
    expect(migrate).toMatch(/^npx --no-install prisma db seed$/m);
    expect(migrate).toMatch(/^set -eu$/m);
    // Only the web service migrates: one migration per deploy.
    const others = allServices.filter((s) => s.type !== 'web' && s.preDeployCommand);
    expect(others).toHaveLength(0);
  });

  it.each(ENV_NAMES)('%s: every app service gets its database, Key Value and groups', (name) => {
    const e = env(name);
    const apps = appServices(e);
    expect(apps).toHaveLength(1 + Object.keys(QUEUES).length);
    for (const s of apps) {
      expect(s.runtime, s.name).toBe('docker');
      const vars = s.envVars ?? [];
      expect(vars.find((v) => v.key === 'RENDER_POSTGRES_URL')?.fromDatabase).toEqual({
        name: `studio-db-${name}`,
        property: 'connectionString',
      });
      expect(vars.find((v) => v.key === 'REDIS_URL')?.fromService).toEqual({
        type: 'keyvalue',
        name: `studio-kv-${name}`,
        property: 'connectionString',
      });
      expect(
        vars.some((v) => v.key === 'DATABASE_URL'),
        s.name,
      ).toBe(false);
      expect(vars.flatMap((v) => (v.fromGroup ? [v.fromGroup] : []))).toEqual([
        `studio-config-${name}`,
        `studio-metrics-${name}`,
        `studio-secrets-${name}`,
      ]);
      expect(vars.find((v) => v.key === 'STUDIO_DB_CONNECTION_LIMIT')?.value, s.name).toMatch(
        /^\d+$/,
      );
    }
  });

  it('staging deploys after CI passes; production never deploys on its own', () => {
    for (const s of env('staging').services.filter((x) => x.runtime === 'docker')) {
      expect(s.autoDeployTrigger, s.name).toBe('checksPass');
    }
    for (const s of env('production').services.filter((x) => x.runtime === 'docker')) {
      expect(s.autoDeployTrigger, s.name).toBe('off');
    }
  });

  it.each(ENV_NAMES)(
    '%s: every env var the code requires at start-up is provided (render.yaml or the runbook)',
    (name) => {
      const e = env(name);
      const operator = operatorKeys(name);
      for (const s of appServices(e)) {
        const provided = providedKeys(e, s);
        if (provided.has('RENDER_POSTGRES_URL')) provided.add('DATABASE_URL');
        const missing = requiredAtStartup().filter((k) => !provided.has(k) && !operator.has(k));
        expect(missing, s.name).toEqual([]);
      }
    },
  );

  it('the required list is derived from the code and includes the core integration points', () => {
    expect(requiredAtStartup()).toEqual(
      expect.arrayContaining([
        'APP_URL',
        'DATABASE_URL',
        'POSTMIND_JWKS_URL',
        'POSTMIND_SERVICE_TOKEN',
        'REDIS_URL',
        'S3_BUCKET_ASSETS',
        'STUDIO_USD_TO_GBP_RATE',
      ]),
    );
  });

  it('every key render.yaml sets for the app is documented in .env.example', () => {
    const example = read('.env.example');
    const renderOnly = new Set(['PORT']); // Render's own variable (also in .env.example)
    for (const e of environments) {
      for (const s of appServices(e)) {
        for (const key of providedKeys(e, s)) {
          if (renderOnly.has(key)) continue;
          expect(example, key).toMatch(new RegExp(`^${key}=`, 'm'));
        }
      }
    }
  });
});

describe('render.yaml — secrets', () => {
  const SECRET =
    /(SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|DSN|WEBHOOK_URL|ROUTING_KEY)/;
  const everyVar = [
    ...allServices.flatMap((s) => s.envVars ?? []),
    ...allGroups.flatMap((g) => g.envVars),
  ];

  it('no secret has a literal value', () => {
    const literal = everyVar.filter((v) => v.key && SECRET.test(v.key) && v.value !== undefined);
    expect(literal.map((v) => v.key)).toEqual([]);
  });

  it('secrets come from generateValue, a sync: false prompt, or the secrets group', () => {
    for (const v of everyVar.filter((x) => x.key && SECRET.test(x.key))) {
      expect(v.generateValue === true || v.sync === false, v.key).toBe(true);
    }
  });

  it('groups never use sync: false (Render ignores it in groups)', () => {
    for (const g of allGroups) {
      expect(
        g.envVars.filter((v) => v.sync === false),
        g.name,
      ).toEqual([]);
    }
  });

  it.each(ENV_NAMES)('%s: the secrets group is left for the dashboard', (name) => {
    expect(env(name).envVarGroups.find((g) => g.name === `studio-secrets-${name}`)).toEqual({
      name: `studio-secrets-${name}`,
      envVars: [],
    });
  });

  it.each(ENV_NAMES)('%s: METRICS_TOKEN is generated once and shared', (name) => {
    const group = env(name).envVarGroups.find((g) => g.name === `studio-metrics-${name}`);
    expect(group?.envVars).toEqual([{ key: 'METRICS_TOKEN', generateValue: true }]);
    const monitoring = env(name).services.find((s) => s.name === `studio-monitoring-${name}`);
    expect(monitoring?.envVars).toContainEqual({ fromGroup: `studio-metrics-${name}` });
  });

  it('POSTMIND_SERVICE_TOKEN is never generated (Core issues it)', () => {
    expect(everyVar.filter((v) => v.key === 'POSTMIND_SERVICE_TOKEN')).toEqual([]);
  });

  it('operator-supplied keys are not also set in render.yaml', () => {
    for (const name of ENV_NAMES) {
      const e = env(name);
      const inYaml = new Set(e.services.flatMap((s) => [...providedKeys(e, s)]));
      const clash = [...operatorKeys(name)].filter((k) => inYaml.has(k));
      expect(clash, name).toEqual([]);
    }
  });
});

describe('render.yaml — monitoring', () => {
  const template = read('ops/render/monitoring/prometheus.yml.tmpl');
  const entrypoint = read('ops/render/monitoring/entrypoint.sh');
  const placeholders = [...new Set([...template.matchAll(/__([A-Z_]+)__/g)].map((m) => m[1]!))];

  it('the entrypoint substitutes every placeholder in the Prometheus template', () => {
    expect(placeholders.length).toBeGreaterThan(0);
    for (const p of placeholders) expect(entrypoint, p).toContain(`s/__${p}__/`);
  });

  it('the rendered config keeps the job names the alert rules use', () => {
    let rendered = template;
    for (const p of placeholders)
      rendered = rendered.split(`__${p}__`).join(`host-${p.toLowerCase()}`);
    const config = load(rendered) as {
      rule_files: string[];
      scrape_configs: Array<{
        job_name: string;
        dns_sd_configs?: Array<{ names: string[]; port: number }>;
      }>;
    };
    const jobs = config.scrape_configs.map((j) => j.job_name);
    expect(jobs).toEqual(
      expect.arrayContaining(['studio-web', 'studio-worker', 'studio-readiness']),
    );
    const worker = config.scrape_configs.find((j) => j.job_name === 'studio-worker')!;
    expect(worker.dns_sd_configs?.[0]?.names).toHaveLength(Object.keys(QUEUES).length);
    expect(worker.dns_sd_configs?.[0]?.port).toBe(9464);
    expect(config.rule_files).toEqual([
      '/etc/prometheus/rules/studio-alerts.yml',
      '/etc/prometheus/rules/studio-slo.yml',
    ]);
    const alerts = read('ops/prometheus/studio-alerts.yml');
    for (const job of ['studio-web', 'studio-worker', 'studio-readiness']) {
      expect(alerts).toContain(job);
    }
  });

  it.each(ENV_NAMES)('%s: monitoring gets every app host from its own environment', (name) => {
    const e = env(name);
    const monitoring = e.services.find((s) => s.name === `studio-monitoring-${name}`)!;
    expect(monitoring.type).toBe('pserv');
    const hostVars = (monitoring.envVars ?? []).filter((v) => v.fromService?.property === 'host');
    const targets = hostVars.map((v) => v.fromService!.name).sort();
    expect(targets).toEqual(
      appServices(e)
        .map((s) => s.name)
        .sort(),
    );
    for (const v of hostVars) expect(entrypoint).toContain(`host_var ${v.key}`);
    for (const key of ['PAGERDUTY_ROUTING_KEY', 'SLACK_WEBHOOK_URL']) {
      expect(monitoring.envVars).toContainEqual({ key, sync: false });
    }
  });
});

describe('render.yaml — object-storage backup cron (Phase 17.5)', () => {
  const COMMAND = 'npx tsx scripts/ops/backup-storage.ts --apply';
  const cronOf = (name: string) => {
    const crons = env(name).services.filter((s) => s.type === 'cron');
    expect(crons).toHaveLength(1);
    return crons[0]!;
  };

  it.each(ENV_NAMES)('%s: runs the backup daily on the app image, with --apply', (name) => {
    const cron = cronOf(name);
    expect(cron).toMatchObject({
      name: `studio-backup-storage-${name}`,
      runtime: 'docker',
      dockerfilePath: './Dockerfile',
      dockerCommand: COMMAND,
    });
    // Daily (UTC): minute and hour fixed, every day.
    expect(cron.schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
    const script = read('scripts/ops/backup-storage.ts');
    expect(script).toContain('runBackup(');
  });

  it.each(ENV_NAMES)('%s: object storage only — no database, no Key Value', (name) => {
    const cron = cronOf(name);
    expect(cron.dockerCommand?.startsWith(WRAPPER)).toBe(false);
    const vars = cron.envVars ?? [];
    expect(vars.some((v) => v.fromDatabase || v.fromService)).toBe(false);
    expect(keysOf(vars)).not.toContain('RENDER_POSTGRES_URL');
  });

  it.each(ENV_NAMES)('%s: gets storage config + secrets and its own backup token', (name) => {
    const e = env(name);
    const cron = cronOf(name);
    const groups = (cron.envVars ?? []).flatMap((v) => (v.fromGroup ? [v.fromGroup] : []));
    expect(groups).toEqual([`studio-config-${name}`, `studio-secrets-${name}`]);
    for (const key of [
      'S3_BACKUP_BUCKET',
      'S3_BACKUP_ACCESS_KEY_ID',
      'S3_BACKUP_SECRET_ACCESS_KEY',
    ]) {
      expect(cron.envVars).toContainEqual({ key, sync: false });
    }
    const provided = providedKeys(e, cron);
    const operator = operatorKeys(name);
    // What backupConfigFromEnv reads on R2 (storage-client.ts + storage-backup.ts).
    for (const key of [
      'STORAGE_PROVIDER',
      'R2_ACCOUNT_ID',
      'R2_JURISDICTION',
      'S3_BUCKET_ASSETS',
      'S3_BUCKET_RENDERS',
      'S3_BUCKET_THUMBNAILS',
      'S3_BACKUP_BUCKET',
      'S3_BACKUP_REGION',
      'S3_BACKUP_RETENTION_DAYS',
    ]) {
      expect(provided.has(key) || operator.has(key), `${name}: ${key}`).toBe(true);
    }
    // Retention is never longer than the 30 days the runbooks promise for purged data.
    const retention = (cron.envVars ?? []).find((v) => v.key === 'S3_BACKUP_RETENTION_DAYS');
    expect(Number(retention?.value)).toBeGreaterThanOrEqual(1);
    expect(Number(retention?.value)).toBeLessThanOrEqual(30);
  });

  it('every key the cron job sets is documented in .env.example', () => {
    const example = read('.env.example');
    for (const name of ENV_NAMES) {
      for (const key of keysOf(cronOf(name).envVars ?? [])) {
        expect(example, key).toMatch(new RegExp(`^${key}=`, 'm'));
      }
    }
  });
});
