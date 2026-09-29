import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { IMAGE_TAG } from '../../src/lib/studio/ops/staging-gate/args';
import { QUEUES } from '../../src/lib/studio/queue/queues';
import { requiredAtStartup } from '../helpers/required-env';

// Deployment: single VPS (Hetzner) — deploy/vps/compose.yml, compose.edge.yml and the scripts,
// checked against the code, the 2 GB default server (Hetzner CPX12: 1 vCPU, 2 GB) and the runbooks.
// Docker is not available where these run, so CI also runs `docker compose config`, shellcheck and
// a stack smoke test (.github/workflows/ci.yml jobs docker and vps-config).

const ROOT = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

type Healthcheck = { test?: unknown; disable?: boolean };
type Service = {
  image?: string;
  build?: unknown;
  command?: string | string[];
  environment?: Record<string, string | number | boolean | null>;
  env_file?: unknown;
  ports?: string[];
  expose?: string[];
  volumes?: string[];
  networks?: string[] | Record<string, { aliases?: string[] } | null>;
  healthcheck?: Healthcheck;
  profiles?: string[];
  restart?: string;
  deploy?: { resources?: { limits?: { cpus?: string; memory?: string } } };
};
type Compose = {
  name: string;
  services: Record<string, Service>;
  volumes?: Record<string, unknown>;
  networks?: Record<string, { external?: boolean; name?: string } | null>;
  secrets?: Record<string, { file: string }>;
};

const app = load(read('deploy/vps/compose.yml')) as Compose;
const edge = load(read('deploy/vps/compose.edge.yml')) as Compose;
const all = { ...app.services, ...edge.services };
const envExample = read('deploy/vps/.env.example');
const backupExample = read('deploy/vps/backup.env.example');

/** A compose value with every ${VAR:-default} replaced by its default (what an empty env gives). */
function withDefaults(value: string): string {
  return value.replace(/\$\{[A-Z0-9_]+(?::?-([^}]*))?(?::?\?[^}]*)?\}/g, (_m, def?: string) =>
    def === undefined ? '' : def,
  );
}

function mebibytes(raw: string | undefined): number {
  const m = /^(\d+(?:\.\d+)?)([kmg])?b?$/i.exec(withDefaults(raw ?? '').trim());
  if (!m) throw new Error(`not a memory size: ${raw}`);
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  return unit === 'g' ? n * 1024 : unit === 'k' ? n / 1024 : unit === 'm' ? n : n / 1024 / 1024;
}

const commandText = (s: Service) =>
  Array.isArray(s.command) ? s.command.join(' ') : (s.command ?? '');
const limits = (s: Service) => s.deploy?.resources?.limits ?? {};
const isDefaultOn = (s: Service) => !s.profiles?.length;
const isLongRunning = (s: Service) => s.restart !== 'no';

/** Keys of an env example file inside one section (between two `# ====` banner blocks). */
function exampleKeys(text: string, section?: 'REQUIRED' | 'OPTIONAL'): Set<string> {
  let body = text;
  if (section) {
    const start = text.indexOf(`# ${section}`);
    expect(start, `${section} section`).toBeGreaterThan(-1);
    const after = text.slice(start);
    const next = after.slice(1).search(/\n# ={20,}\n# [A-Z]/);
    body = next === -1 ? after : after.slice(0, next + 1);
  }
  return new Set([...body.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));
}

const SECRET =
  /(SECRET|TOKEN|PASSWORD|PASS\b|_PASS$|API_KEY|ACCESS_KEY|PRIVATE_KEY|DSN|WEBHOOK_URL)/;

describe('VPS compose — images', () => {
  it('pins every image to a version (never latest)', () => {
    for (const [name, s] of Object.entries(all)) {
      if (!s.image) {
        expect(s.build, `${name} has neither image nor build`).toBeDefined();
        continue;
      }
      if (name === 'postgres' || name === 'postgres-restore') {
        expect(s.image, name).toMatch(/^postmind-studio-postgres:17-pgvector-0\.8\.6-local$/);
        continue;
      }
      if (s.image.includes('${IMAGE_TAG')) {
        // The app image: the tag is the commit SHA deploy.sh passes, required (:?).
        expect(s.image, name).toMatch(/:\$\{IMAGE_TAG:\?[^}]+\}$/);
        continue;
      }
      expect(s.image, name).toMatch(/^[a-z0-9./-]+:v?\d+(\.\d+)+[\w.-]*$/);
      expect(s.image, name).not.toMatch(/:latest$/);
    }
  });

  it('builds Postgres from the pgvector image CI migrates against', () => {
    const dockerfile = read('deploy/vps/postgres/Dockerfile');
    const from = /^FROM (\S+)$/m.exec(dockerfile)?.[1];
    expect(from).toBe('pgvector/pgvector:0.8.6-pg17-bookworm');
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('image: pgvector/pgvector:0.8.6-pg17');
    expect(dockerfile).toMatch(/apt-get install .*pgbackrest/);
    expect(app.services.postgres!.build).toEqual({ context: './postgres' });
  });

  it('the app image defaults to the one CI publishes to GHCR', () => {
    expect(app.services.web!.image).toContain(
      '${STUDIO_IMAGE:-ghcr.io/infoworksdomain-blip/postmind-studio}',
    );
    const ci = load(read('.github/workflows/ci.yml')) as {
      jobs: Record<string, { if?: string; env?: Record<string, string>; steps: unknown[] }>;
    };
    const publish = ci.jobs['publish-image']!;
    expect(publish.if).toContain("github.ref == 'refs/heads/main'");
    expect(publish.env?.IMAGE).toBe('ghcr.io/infoworksdomain-blip/postmind-studio');
    const steps = JSON.stringify(publish.steps);
    expect(steps).toContain('provenance');
    expect(steps).toContain('actions/attest@');
    expect(steps).toContain('${{ github.sha }}');
  });
});

describe('VPS compose — network exposure', () => {
  it('never publishes Postgres, Redis, web or the worker on a host port', () => {
    for (const name of ['postgres', 'postgres-restore', 'redis', 'web', 'worker', 'browserless']) {
      expect(app.services[name]!.ports, name).toBeUndefined();
    }
  });

  it('binds every other published app port to 127.0.0.1', () => {
    for (const [name, s] of Object.entries(app.services)) {
      for (const port of s.ports ?? []) expect(port, name).toMatch(/^'?127\.0\.0\.1:/);
    }
  });

  it('only Caddy publishes public ports: 80 and 443 (tcp + udp)', () => {
    expect(Object.keys(edge.services)).toEqual(['caddy']);
    expect(edge.services.caddy!.ports).toEqual(['80:80', '443:443', '443:443/udp']);
  });

  it('web joins the shared edge network under the name the Caddy site proxies to', () => {
    const nets = app.services.web!.networks as Record<string, { aliases?: string[] } | null>;
    expect(nets.edge?.aliases).toEqual(['studio-web-${STUDIO_ENV}']);
    expect(app.networks?.edge).toEqual({ external: true, name: 'studio-edge' });
    expect(edge.networks?.edge).toEqual({ name: 'studio-edge' });
    expect(read('deploy/vps/caddy/site.caddy.tmpl')).toContain(
      'reverse_proxy studio-web-__ENV__:3010',
    );
    // Only web is on the edge network.
    for (const [name, s] of Object.entries(app.services)) {
      if (name === 'web') continue;
      const nets2 = Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {});
      expect(nets2, name).not.toContain('edge');
    }
  });

  it('the browser for website scans shares a network with the worker only', () => {
    expect(app.services.browserless!.networks).toEqual(['headless']);
    const onHeadless = Object.entries(app.services).filter(([, s]) => {
      const nets = Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {});
      return nets.includes('headless');
    });
    expect(onHeadless.map(([n]) => n).sort()).toEqual(['browserless', 'worker']);
  });

  it('the Caddy site hides /api/metrics and limits the internal API', () => {
    const site = read('deploy/vps/caddy/site.caddy.tmpl');
    expect(site).toMatch(
      /@metrics path \/api\/metrics \/api\/metrics\/\*\n\s*respond @metrics 404/,
    );
    expect(site).toMatch(/path \/api\/studio\/internal \/api\/studio\/internal\/\*/);
    expect(site).toContain('not client_ip __INTERNAL_CIDRS__');
    expect(site).toContain('respond @internal_denied 404');
    const caddyfile = read('deploy/vps/caddy/Caddyfile');
    expect(caddyfile).toContain('import /etc/caddy-sites/*.caddy');
    expect(caddyfile).toContain('email {$ACME_EMAIL}');
  });
});

describe('VPS compose — Redis (BullMQ)', () => {
  const redis = app.services.redis!;
  const args = (redis.command as string[]).map(String);
  const flag = (name: string) => args[args.indexOf(name) + 1];

  it('uses noeviction (BullMQ requirement) with a maxmemory', () => {
    expect(flag('--maxmemory-policy')).toBe('noeviction');
    expect(mebibytes(flag('--maxmemory'))).toBeGreaterThan(0);
    expect(mebibytes(flag('--maxmemory'))).toBeLessThan(mebibytes(limits(redis).memory));
  });

  it('persists with AOF (fsync every second) and RDB on a named volume', () => {
    expect(flag('--appendonly')).toBe('yes');
    expect(flag('--appendfsync')).toBe('everysec');
    expect(flag('--save')).toMatch(/^\d+ \d+/);
    expect(redis.volumes).toEqual(['redis-data:/data']);
    expect(app.volumes).toHaveProperty('redis-data');
  });

  it('the app uses Redis DB 3', () => {
    const env = app.services.web!.environment!;
    expect(env.REDIS_URL).toBe('redis://redis:6379/3');
  });
});

describe('VPS compose — Postgres and backups', () => {
  const pg = app.services.postgres!;
  const conf = read('deploy/vps/postgres/postgresql.conf');

  it('keeps data on a named volume at the PG 17 data path', () => {
    expect(pg.volumes).toContain('postgres-data:/var/lib/postgresql/data');
  });

  it('archives WAL with pgBackRest to the backup bucket, per environment, encrypted', () => {
    expect(conf).toMatch(/^wal_level = replica$/m);
    expect(conf).toMatch(/^archive_command = 'pgbackrest --stanza=studio archive-push %p'$/m);
    expect(conf).toMatch(/^archive_timeout = 60$/m);
    expect(commandText(pg)).toContain('archive_mode=${PG_BACKUPS:-on}');
    const env = pg.environment!;
    expect(env.PGBACKREST_STANZA).toBe('studio');
    expect(env.PGBACKREST_REPO1_TYPE).toBe('s3');
    expect(env.PGBACKREST_REPO1_S3_BUCKET).toBe('${S3_BACKUP_BUCKET:-unset}');
    expect(env.PGBACKREST_REPO1_PATH).toBe('/postgres/${STUDIO_ENV}');
    expect(env.PGBACKREST_REPO1_CIPHER_TYPE).toBe('aes-256-cbc');
    expect(env.PGBACKREST_REPO1_RETENTION_FULL_TYPE).toBe('time');
  });

  it('retention keeps backup data within 30 days (weekly full + retention days + 1)', () => {
    const env = pg.environment!;
    const days = Number(withDefaults(String(env.PGBACKREST_REPO1_RETENTION_FULL)));
    expect(days + 7 + 1).toBeLessThanOrEqual(30);
    expect(read('scripts/vps/deploy.sh')).toContain('[ "$days" -gt 22 ]');
    expect(read('scripts/vps/backup.sh')).toMatch(/date -u \+%u\)" = "7" \]; then kind="full"/);
    // The object-storage copy keeps the same promise (Phase 17.5).
    expect(app.services['backup-storage']!.environment!.S3_BACKUP_RETENTION_DAYS).toBe('30');
  });

  it('backup credentials never reach web or worker', () => {
    for (const name of ['web', 'worker', 'migrate', 'ops']) {
      const text = JSON.stringify(app.services[name]);
      expect(text, name).not.toMatch(
        /S3_BACKUP_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)|PG_BACKUP_CIPHER_PASS/,
      );
      expect(text, name).not.toContain('backup.env');
    }
    for (const key of [
      'S3_BACKUP_ACCESS_KEY_ID',
      'S3_BACKUP_SECRET_ACCESS_KEY',
      'PG_BACKUP_CIPHER_PASS',
    ]) {
      expect(exampleKeys(envExample).has(key), key).toBe(false);
      expect(exampleKeys(backupExample).has(key), key).toBe(true);
    }
  });

  it('the restore drill runs with archiving off, on its own volume', () => {
    const restore = app.services['postgres-restore']!;
    expect(restore.profiles).toEqual(['restore']);
    expect(commandText(restore)).toContain('archive_mode=off');
    expect(restore.volumes).toContain('postgres-restore-data:/var/lib/postgresql/data');
    expect(app.services.ops!.environment!.RESTORED_DATABASE_URL).toMatch(
      /@postgres-restore:5432\//,
    );
  });

  it('DATABASE_URL uses the studio schema and a bounded pool that fits max_connections', () => {
    const maxConnections = Number(
      withDefaults(commandText(pg).match(/max_connections=(\S+)/)![1]!),
    );
    let total = 0;
    for (const name of ['web', 'worker', 'migrate', 'ops']) {
      const url = withDefaults(String(app.services[name]!.environment!.DATABASE_URL));
      expect(url, name).toMatch(
        /^postgresql:\/\/studio:@postgres:5432\/postmind_studio\?schema=studio&/,
      );
      total += Number(/connection_limit=(\d+)/.exec(url)![1]);
    }
    // + pgBackRest, psql and headroom
    expect(total + 5).toBeLessThanOrEqual(maxConnections);
  });
});

describe('VPS compose — app services', () => {
  it('the worker runs every queue in src/lib/studio/queue/queues.ts by default', () => {
    const command = commandText(app.services.worker!);
    const m = /^node --import tsx scripts\/worker\.ts \$\{STUDIO_WORKER_QUEUES:-([^}]+)\}$/.exec(
      command,
    );
    expect(m, command).not.toBeNull();
    expect(m![1]!.split(' ').sort()).toEqual(Object.values(QUEUES).sort());
    const prom = load(read('deploy/vps/prometheus/prometheus.yml')) as {
      scrape_configs: Array<{
        job_name: string;
        dns_sd_configs?: Array<{ names: string[]; port: number }>;
      }>;
    };
    const worker = prom.scrape_configs.find((j) => j.job_name === 'studio-worker')!;
    expect(worker.dns_sd_configs).toEqual([
      { names: ['worker'], type: 'A', port: 9464, refresh_interval: '30s' },
    ]);
    const jobs = prom.scrape_configs.map((j) => j.job_name);
    expect(jobs).toEqual(
      expect.arrayContaining(['studio-web', 'studio-worker', 'studio-readiness']),
    );
  });

  it('migrations run once per deploy, before web and worker', () => {
    const migrate = app.services.migrate!;
    expect(migrate.profiles).toEqual(['migrate']);
    expect(migrate.restart).toBe('no');
    expect(commandText(migrate)).toContain(
      'npx --no-install prisma migrate deploy && npx --no-install prisma db seed',
    );
    const main = read('scripts/vps/deploy.sh').split('main() {')[1]!;
    const order = [
      'preflight',
      'start_edge',
      'start_datastores',
      'ensure_backups',
      'migrate',
      'roll_out',
      'write_site',
      'wait_ready',
      'record_tag',
    ];
    const positions = order.map((step) => main.indexOf(`\n  ${step}\n`));
    for (const [i, p] of positions.entries()) expect(p, order[i]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('every long-running service has a healthcheck (browserless excepted), and a restart policy', () => {
    for (const [name, s] of Object.entries(all)) {
      if (!isLongRunning(s)) continue;
      expect(s.restart, name).toBe('unless-stopped');
      if (name === 'browserless') continue;
      expect(s.healthcheck?.test, name).toBeDefined();
      expect(s.healthcheck?.disable, name).not.toBe(true);
    }
  });

  it('the worker healthcheck uses the metrics listener, web the liveness route', () => {
    expect(JSON.stringify(app.services.worker!.healthcheck)).toContain('127.0.0.1:9464/metrics');
    expect(JSON.stringify(app.services.web!.healthcheck)).toContain('127.0.0.1:3010/api/health');
  });

  it('every service rotates its logs and has memory and CPU limits', () => {
    for (const [name, s] of Object.entries(all)) {
      const logging = (s as { logging?: { driver: string; options: Record<string, string> } })
        .logging;
      expect(logging?.driver, name).toBe('json-file');
      expect(logging?.options['max-size'], name).toBeDefined();
      expect(limits(s).memory, name).toBeDefined();
      expect(limits(s).cpus, name).toBeDefined();
    }
  });

  it('workers get time to finish in-flight jobs on SIGTERM', () => {
    expect((app.services.worker as { stop_grace_period?: string }).stop_grace_period).toBe('120s');
  });
});

describe('VPS compose — fits the default 2 GB / 1 vCPU server (Hetzner CPX12)', () => {
  const defaultOn = [
    ...Object.entries(app.services).filter(([, s]) => isDefaultOn(s) && isLongRunning(s)),
    ...Object.entries(edge.services),
  ];

  it('runs Postgres, Redis, web, worker and Caddy by default; monitoring and extras are opt-in', () => {
    expect(defaultOn.map(([n]) => n).sort()).toEqual([
      'caddy',
      'postgres',
      'redis',
      'web',
      'worker',
    ]);
    for (const name of ['prometheus', 'alertmanager', 'blackbox']) {
      expect(app.services[name]!.profiles, name).toEqual(['monitoring']);
    }
    expect(app.services.browserless!.profiles).toEqual(['headless-render']);
    expect(envExample).toMatch(/^STUDIO_MONITORING=off$/m);
  });

  it('the production services memory limits add up to less than 1.8 GB', () => {
    const total = defaultOn.reduce((sum, [, s]) => sum + mebibytes(limits(s).memory), 0);
    expect(total).toBeLessThanOrEqual(1800);
  });

  it('no default CPU limit exceeds the 1 vCPU of the smallest server', () => {
    for (const [name, s] of Object.entries(all)) {
      expect(Number(withDefaults(String(limits(s).cpus))), name).toBeLessThanOrEqual(1);
    }
  });

  it('V8 heaps are capped below the container limits', () => {
    for (const name of ['web', 'worker']) {
      const s = app.services[name]!;
      const heap = Number(
        withDefaults(String(s.environment!.NODE_OPTIONS)).match(/--max-old-space-size=(\d+)/)![1],
      );
      expect(heap, name).toBeLessThan(mebibytes(limits(s).memory) * 0.75);
    }
  });

  it('Postgres memory settings fit its container limit', () => {
    const cmd = withDefaults(commandText(app.services.postgres!));
    const setting = (key: string) =>
      mebibytes(cmd.match(new RegExp(`${key}=(\\S+)`))![1]!.replace(/B$/, ''));
    const limit = mebibytes(limits(app.services.postgres!).memory);
    expect(setting('shared_buffers')).toBeLessThanOrEqual(limit * 0.3);
    expect(
      setting('work_mem') * 10 + setting('maintenance_work_mem') + setting('shared_buffers'),
    ).toBeLessThan(limit);
  });

  it('FFmpeg is limited to one child at a time and queue concurrency is low', () => {
    const keys = (name: string) => new RegExp(`^${name}=(\\d+)$`, 'm').exec(envExample)?.[1];
    expect(keys('STUDIO_FFMPEG_MAX_CONCURRENT')).toBe('1');
    expect(Number(keys('STUDIO_LIBRARY_CONCURRENCY'))).toBe(1);
    for (const q of ['ORCHESTRATION', 'ASSETS', 'PUBLISH', 'SCHEDULED', 'ANALYTICS']) {
      expect(Number(keys(`WORKER_CONCURRENCY_${q}`)), q).toBeLessThanOrEqual(3);
    }
  });

  it('bootstrap adds swap by default', () => {
    expect(read('deploy/vps/bootstrap.sh')).toMatch(/^SWAP_SIZE="\$\{SWAP_SIZE:-2G\}"$/m);
  });
});

describe('VPS environment files', () => {
  const composeEnv = (name: string) => new Set(Object.keys(app.services[name]!.environment ?? {}));
  const required = exampleKeys(envExample, 'REQUIRED');

  it.each(['web', 'worker', 'migrate'])(
    '%s: every env var the code requires at start-up is set by compose or REQUIRED in .env.example',
    (name) => {
      const provided = new Set([...composeEnv(name), ...required]);
      const missing = requiredAtStartup('standalone').filter((k) => !provided.has(k));
      expect(missing).toEqual([]);
    },
  );

  it('compose interpolates only variables the example files document', () => {
    const documented = new Set([...exampleKeys(envExample), ...exampleKeys(backupExample)]);
    // Set by scripts/vps/compose.sh / deploy.sh, not by the operator.
    const fromScripts = new Set([
      'IMAGE_TAG',
      'STUDIO_ENV_FILE',
      'STUDIO_SECRETS_DIR',
      'STUDIO_STATE_DIR',
    ]);
    for (const file of ['deploy/vps/compose.yml', 'deploy/vps/compose.edge.yml']) {
      const vars = [...read(file).matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]!);
      for (const v of new Set(vars)) {
        expect(documented.has(v) || fromScripts.has(v), `${file}: ${v}`).toBe(true);
      }
    }
  });

  it('keys compose sets itself are not also in .env.example (one source of truth)', () => {
    const own = new Set([...composeEnv('web'), ...composeEnv('worker')]);
    const clash = [...exampleKeys(envExample)].filter((k) => own.has(k));
    expect(clash).toEqual([]);
  });

  it('the deploy preflight checks the keys the app cannot start without', () => {
    const deploy = read('scripts/vps/deploy.sh');
    for (const key of requiredAtStartup('standalone')) {
      if (
        ['DATABASE_URL', 'REDIS_URL', 'APP_URL', 'STORAGE_PROVIDER', 'METRICS_TOKEN'].includes(key)
      )
        continue;
      if (['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].includes(key)) continue; // KMS may use a role elsewhere; checked by the app
      expect(deploy, key).toContain(key);
    }
    expect(deploy).toContain('require_value METRICS_TOKEN');
  });

  it('the image-tag rule matches the staging gate', () => {
    const lib = read('scripts/vps/lib.sh');
    const pattern = /^TAG_PATTERN='(.+)'$/m.exec(lib)![1];
    expect(pattern).toBe(IMAGE_TAG.source);
  });
});

describe('VPS — no literal secrets', () => {
  it('compose never holds a secret value, only ${…} references', () => {
    for (const [name, s] of Object.entries(all)) {
      for (const [key, value] of Object.entries(s.environment ?? {})) {
        const text = String(value ?? '');
        if (SECRET.test(key))
          expect(text, `${name}.${key}`).toMatch(/^\$\{[A-Z0-9_]+(:[-?][^}]*)?\}$/);
        // URLs with credentials take the password from the env file.
        const creds = /:\/\/[^:/@]+:([^@]*)@/.exec(text);
        if (creds) expect(creds[1], `${name}.${key}`).toBe('${POSTGRES_PASSWORD}');
      }
    }
  });

  it('the example env files leave every secret empty', () => {
    for (const text of [envExample, backupExample]) {
      for (const m of text.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)) {
        if (SECRET.test(m[1]!)) expect(m[2], m[1]).toBe('');
      }
    }
  });

  it('scripts and config contain no key material', () => {
    const files = [
      'deploy/vps/bootstrap.sh',
      'deploy/vps/compose.yml',
      'deploy/vps/compose.edge.yml',
      'deploy/vps/caddy/Caddyfile',
      'deploy/vps/prometheus/prometheus.yml',
      'scripts/vps/lib.sh',
      'scripts/vps/deploy.sh',
      'scripts/vps/backup.sh',
      'scripts/vps/pg-restore.sh',
      'scripts/vps/healthcheck.sh',
      'scripts/vps/compose.sh',
      'scripts/vps/install-timers.sh',
      'scripts/vps/ci-fixture.sh',
    ];
    for (const file of files) {
      const text = read(file);
      expect(text, file).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(text, file).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/);
      expect(text, file).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}/);
      expect(text, file).not.toMatch(/hooks\.slack\.com\/services\/T/);
    }
  });

  it('filled-in env files cannot be committed', () => {
    const ignore = read('.gitignore');
    expect(ignore).toContain('deploy/vps/*.env');
    expect(ignore).toContain('deploy/vps/secrets/');
  });
});

describe('VPS — staging on the same server', () => {
  it('deploy.sh maps each environment to its own compose project (own volumes and networks)', () => {
    const lib = read('scripts/vps/lib.sh');
    expect(lib).toContain('production) PROJECT="postmind-studio" ;;');
    expect(lib).toContain('staging) PROJECT="postmind-studio-staging" ;;');
    // No fixed container names: they would clash between the two projects.
    for (const [name, s] of Object.entries(app.services)) {
      expect((s as { container_name?: string }).container_name, name).toBeUndefined();
    }
  });

  it('deploy.sh works as STAGING_DEPLOY_CMD (a {tag} argument, --env, --ssh)', () => {
    const deploy = read('scripts/vps/deploy.sh');
    expect(deploy).toContain('scripts/vps/deploy.sh --env staging --ssh deploy@<ip> {tag}');
    expect(deploy).toContain('--previous');
    expect(deploy).toContain('--stop');
    expect(read('runbooks/staging-gate.md')).toContain('scripts/vps/deploy.sh --env staging --ssh');
  });
});
