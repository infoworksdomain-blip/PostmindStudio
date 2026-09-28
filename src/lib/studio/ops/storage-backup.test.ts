import { describe, expect, it } from 'vitest';
import { ConfigurationError, ValidationError } from '../../errors';
import { purgeBucketsFromEnv } from '../services/purge-storage';
import {
  backupConfigFromEnv,
  backupKeyFor,
  DEFAULT_RETENTION_DAYS,
  endpointOf,
  isUpToDate,
  MAX_SINGLE_COPY_BYTES,
  parseBackupArgs,
  parseState,
  planBucket,
  retentionDaysFromEnv,
  serialiseState,
  type ObjectEntry,
} from './storage-backup';

// Phase 17.5 — backup copy: configuration, plan, state, CLI flags.

const R2 = {
  STORAGE_PROVIDER: 'r2',
  R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  R2_JURISDICTION: 'eu',
  R2_ACCESS_KEY_ID: 'app-key',
  R2_SECRET_ACCESS_KEY: 'app-secret',
  S3_BUCKET_ASSETS: 'live-assets',
  S3_BUCKET_RENDERS: 'live-renders',
  S3_BUCKET_THUMBNAILS: 'live-thumbs',
  S3_BACKUP_BUCKET: 'studio-backup',
};
const S3 = {
  AWS_REGION: 'eu-west-2',
  S3_BUCKET_ASSETS: 'live-assets',
  S3_BACKUP_BUCKET: 'studio-backup',
};

const NOW = new Date('2026-09-28T03:30:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const obj = (key: string, extra: Partial<ObjectEntry> = {}): ObjectEntry => ({
  key,
  size: 10,
  etag: `"${key}"`,
  lastModified: new Date('2026-09-01T00:00:00Z'),
  ...extra,
});

describe('backupConfigFromEnv', () => {
  it('R2: same endpoint → server-side copy; the backup token signs both sides', () => {
    const config = backupConfigFromEnv({
      ...R2,
      S3_BACKUP_ACCESS_KEY_ID: 'backup-key',
      S3_BACKUP_SECRET_ACCESS_KEY: 'backup-secret',
    });
    expect(config.serverSideCopy).toBe(true);
    expect(config.backupClient.endpoint).toBe(
      'https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com',
    );
    for (const c of [config.sourceClient, config.backupClient]) {
      expect(c.credentials).toEqual({
        accessKeyId: 'backup-key',
        secretAccessKey: 'backup-secret',
      });
      expect(c.requestChecksumCalculation).toBe('WHEN_REQUIRED');
    }
    expect(config.sources).toEqual([
      { logical: 'assets', bucket: 'live-assets' },
      { logical: 'renders', bucket: 'live-renders' },
      { logical: 'thumbnails', bucket: 'live-thumbs' },
    ]);
    expect(config.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('R2: a backup bucket in another jurisdiction is streamed', () => {
    const config = backupConfigFromEnv({ ...R2, S3_BACKUP_REGION: 'us' });
    expect(config.serverSideCopy).toBe(false);
    expect(endpointOf(config.backupClient)).toContain('.us.r2.cloudflarestorage.com');
    // Without S3_BACKUP_* keys the storage keys are used.
    expect(config.sourceClient.credentials).toEqual({
      accessKeyId: 'app-key',
      secretAccessKey: 'app-secret',
    });
  });

  it('S3: region decides copy vs stream; explicit keys only when set', () => {
    const same = backupConfigFromEnv(S3);
    expect(same.serverSideCopy).toBe(true);
    expect(same.sourceClient.credentials).toBeUndefined();
    expect(same.skipped).toEqual(['renders', 'thumbnails']);
    const other = backupConfigFromEnv({
      ...S3,
      S3_BACKUP_REGION: 'eu-west-1',
      S3_BACKUP_ACCESS_KEY_ID: 'k',
      S3_BACKUP_SECRET_ACCESS_KEY: 's',
    });
    expect(other.serverSideCopy).toBe(false);
    expect(other.backupClient.region).toBe('eu-west-1');
    expect(other.backupClient.credentials).toEqual({ accessKeyId: 'k', secretAccessKey: 's' });
  });

  it('library only when asked for', () => {
    const config = backupConfigFromEnv({ ...S3, S3_BUCKET_LIBRARY: 'lib' }, ['library']);
    expect(config.sources).toEqual([{ logical: 'library', bucket: 'lib' }]);
  });

  it('refuses a missing backup bucket, half a key pair, or a live bucket as the backup', () => {
    expect(() => backupConfigFromEnv({ ...S3, S3_BACKUP_BUCKET: ' ' })).toThrow(/S3_BACKUP_BUCKET/);
    expect(() => backupConfigFromEnv({ ...S3, S3_BACKUP_ACCESS_KEY_ID: 'k' })).toThrow(
      /both S3_BACKUP_ACCESS_KEY_ID/,
    );
    expect(() => backupConfigFromEnv({ ...S3, S3_BACKUP_BUCKET: 'live-assets' })).toThrow(
      /S3_BUCKET_ASSETS/,
    );
    expect(() =>
      backupConfigFromEnv({ ...S3, S3_FALLBACK_BUCKET_RENDERS: 'studio-backup' }),
    ).toThrow(ConfigurationError);
    expect(() => backupConfigFromEnv({ ...R2, S3_BACKUP_REGION: 'mars' })).toThrow(
      ConfigurationError,
    );
  });
});

describe('retentionDaysFromEnv', () => {
  it('defaults to 30 and accepts 1..30', () => {
    expect(retentionDaysFromEnv({})).toBe(30);
    expect(retentionDaysFromEnv({ S3_BACKUP_RETENTION_DAYS: ' 7 ' })).toBe(7);
  });
  it.each(['0', '31', '2.5', 'soon'])('refuses %s (purged data must age out)', (v) => {
    expect(() => retentionDaysFromEnv({ S3_BACKUP_RETENTION_DAYS: v })).toThrow(ConfigurationError);
  });
});

describe('isUpToDate', () => {
  it('same size and ETag', () => {
    expect(isUpToDate(obj('a'), obj('a', { etag: 'a' }))).toBe(true);
  });
  it('same size, new ETag (server-side copy of a multipart object) but newer copy', () => {
    const source = obj('a', { etag: '"abc-3"' });
    expect(
      isUpToDate(source, obj('a', { etag: '"def"', lastModified: new Date('2026-09-02') })),
    ).toBe(true);
    expect(
      isUpToDate(source, obj('a', { etag: '"def"', lastModified: new Date('2026-08-30') })),
    ).toBe(false);
  });
  it('different size is always a change', () => {
    expect(isUpToDate(obj('a'), obj('a', { size: 11 }))).toBe(false);
  });
});

describe('planBucket', () => {
  const base = { logical: 'assets' as const, now: NOW, retentionDays: 30, tombstones: {} };

  it('copies new and changed objects, skips current ones, reports too-large ones', () => {
    const plan = planBucket({
      ...base,
      source: [
        obj('orgs/o/new.mp4'),
        obj('orgs/o/same.mp4'),
        obj('orgs/o/changed.mp4', { size: 20 }),
        obj('orgs/o/huge.zip', { size: MAX_SINGLE_COPY_BYTES + 1 }),
      ],
      backup: [
        obj('assets/orgs/o/same.mp4', { etag: '"orgs/o/same.mp4"' }),
        obj('assets/orgs/o/changed.mp4'),
      ],
    });
    expect(plan.copy.map((o) => o.key)).toEqual(['orgs/o/new.mp4', 'orgs/o/changed.mp4']);
    expect(plan.copyBytes).toBe(30);
    expect(plan.upToDate).toBe(1);
    expect(plan.tooLarge.map((o) => o.key)).toEqual(['orgs/o/huge.zip']);
    expect(plan.newlyMissing).toEqual([]);
  });

  it('tombstones a deleted source, waits out the retention, then expires it', () => {
    const source = [obj('orgs/keep/a')];
    const backup = [
      obj('assets/orgs/keep/a', { etag: '"orgs/keep/a"' }),
      obj('assets/orgs/gone/b'),
    ];
    const first = planBucket({ ...base, source, backup });
    expect(first.newlyMissing).toEqual(['assets/orgs/gone/b']);
    expect(first.tombstones).toEqual({ 'assets/orgs/gone/b': NOW.toISOString() });
    expect(first.expire).toEqual([]);

    const day29 = planBucket({
      ...base,
      source,
      backup,
      tombstones: { 'assets/orgs/gone/b': daysAgo(29) },
    });
    expect(day29.expire).toEqual([]);
    expect(day29.waiting).toBe(1);

    const day30 = planBucket({
      ...base,
      source,
      backup,
      tombstones: { 'assets/orgs/gone/b': daysAgo(30) },
    });
    expect(day30.expire).toEqual(['assets/orgs/gone/b']);
    expect(day30.tombstones).toEqual({});
  });

  it('clears the tombstone of a restored source and of a copy that is already gone', () => {
    const plan = planBucket({
      ...base,
      source: [obj('orgs/o/back')],
      backup: [obj('assets/orgs/o/back', { etag: '"orgs/o/back"' })],
      tombstones: {
        'assets/orgs/o/back': daysAgo(3),
        'assets/orgs/o/vanished': daysAgo(3),
        'renders/orgs/o/other': daysAgo(40), // another bucket: ignored here
      },
    });
    expect(plan.revived).toBe(1);
    expect(plan.tombstones).toEqual({});
    expect(plan.expire).toEqual([]);
  });

  it('the mass-tombstone valve stops a bucket whose source listing looks wrong', () => {
    const backup = Array.from({ length: 200 }, (_, i) => obj(`assets/orgs/o/${i}`));
    const tombstones = { 'assets/orgs/o/0': daysAgo(31) };
    const blocked = planBucket({ ...base, source: [], backup, tombstones });
    expect(blocked.blocked).toMatch(/--allow-mass-tombstone/);
    expect(blocked.expire).toEqual([]);
    expect(blocked.newlyMissing).toEqual([]);
    expect(blocked.tombstones).toEqual(tombstones);

    const allowed = planBucket({
      ...base,
      source: [],
      backup,
      tombstones,
      allowMassTombstone: true,
    });
    expect(allowed.blocked).toBeUndefined();
    expect(allowed.newlyMissing).toHaveLength(199);
    expect(allowed.expire).toEqual(['assets/orgs/o/0']);
  });

  it('a small deletion is not a mass deletion', () => {
    const backup = Array.from({ length: 10 }, (_, i) => obj(`assets/k${i}`));
    const source = backup.slice(5).map((o) => obj(o.key.slice('assets/'.length)));
    expect(planBucket({ ...base, source, backup }).blocked).toBeUndefined();
  });
});

describe('organisation hard delete and the backup (GDPR)', () => {
  it('the purge never touches the backup bucket; its copies age out instead', () => {
    // purge-storage.ts deletes from the live (and failover) buckets only: the app token has no
    // access to the backup bucket by design (runbooks/backup-recovery.md).
    const env = { ...R2, S3_FALLBACK_BUCKET_ASSETS: 'fallback-assets' };
    expect(purgeBucketsFromEnv(env)).not.toContain('studio-backup');

    // After the purge deletes orgs/purged/ from the live bucket, the backup copies are gone
    // RETENTION_DAYS later.
    const backup = [
      obj('assets/orgs/purged/x'),
      obj('assets/orgs/purged/y'),
      obj('assets/orgs/kept/z'),
    ];
    const source = [obj('orgs/kept/z', { etag: '"assets/orgs/kept/z"' })];
    const t0 = planBucket({
      logical: 'assets',
      source,
      backup,
      tombstones: {},
      now: NOW,
      retentionDays: 30,
    });
    const later = new Date(NOW.getTime() + 30 * 86_400_000);
    const t30 = planBucket({
      logical: 'assets',
      source,
      backup,
      tombstones: t0.tombstones,
      now: later,
      retentionDays: 30,
    });
    expect(t30.expire.sort()).toEqual(['assets/orgs/purged/x', 'assets/orgs/purged/y']);
  });
});

describe('state file', () => {
  it('round-trips, sorted', () => {
    const raw = serialiseState({ 'b/2': NOW.toISOString(), 'a/1': daysAgo(1) }, NOW);
    const state = parseState(raw);
    expect(Object.keys(state.tombstones)).toEqual(['a/1', 'b/2']);
    expect(state.updatedAt).toBe(NOW.toISOString());
  });
  it('no state yet → empty', () => {
    expect(parseState(undefined).tombstones).toEqual({});
  });
  it('a corrupt state is an error, never a silent reset of the retention clocks', () => {
    expect(() => parseState('{')).toThrow(ConfigurationError);
    expect(() => parseState('{"version":2,"updatedAt":"x","tombstones":{}}')).toThrow(
      ConfigurationError,
    );
    expect(() =>
      parseState('{"version":1,"updatedAt":"x","tombstones":{"k":"yesterday"}}'),
    ).toThrow(ConfigurationError);
  });
});

describe('parseBackupArgs', () => {
  it('dry run of the default buckets by default', () => {
    expect(parseBackupArgs([])).toEqual({
      apply: false,
      only: ['assets', 'renders', 'thumbnails'],
      concurrency: 8,
      allowMassTombstone: false,
    });
  });
  it('reads every flag', () => {
    expect(
      parseBackupArgs([
        '--apply',
        '--only',
        'library,assets',
        '--concurrency',
        '4',
        '--allow-mass-tombstone',
      ]),
    ).toEqual({
      apply: true,
      only: ['library', 'assets'],
      concurrency: 4,
      allowMassTombstone: true,
    });
  });
  it.each([
    [['--only', 'videos']],
    [['--only']],
    [['--concurrency', '0']],
    [['--concurrency', '99']],
    [['--delete-everything']],
  ])('refuses %j', (argv) => {
    expect(() => parseBackupArgs(argv)).toThrow(ValidationError);
  });
  it('backup keys keep the source key after the logical prefix', () => {
    expect(backupKeyFor('renders', 'orgs/o/r.mp4')).toBe('renders/orgs/o/r.mp4');
  });
});
