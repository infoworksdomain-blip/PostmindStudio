import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../../errors';
import { DEFAULT_SNAPSHOT_FILE, parseGateArgs } from './args';

describe('parseGateArgs', () => {
  it('parses --k6 with common options', () => {
    expect(parseGateArgs(['--k6', 'full', '--operator', 'amy', '--out-dir', 'tmp/r'])).toEqual({
      kind: 'k6',
      mode: 'full',
      outDir: 'tmp/r',
      operator: 'amy',
    });
    expect(() => parseGateArgs(['--k6', 'soak'])).toThrow('smoke or full');
  });

  it('parses --rehearse with levels, targets and tags', () => {
    const cmd = parseGateArgs([
      '--rehearse',
      'all',
      '--levels',
      'platform,global',
      '--platform',
      'youtube',
      '--from-tag',
      'abc123',
      '--to-tag',
      'def456',
      '--observe-seconds',
      '120',
    ]);
    expect(cmd).toMatchObject({
      kind: 'rehearse',
      what: 'all',
      levels: ['platform', 'global'],
      targets: { platform: 'youtube' },
      observeSeconds: 120,
      fromTag: 'abc123',
      toTag: 'def456',
      outDir: 'ops/results',
    });
  });

  it('defaults to every level and a 90 s observation window', () => {
    expect(parseGateArgs(['--rehearse', 'kill-switch'])).toMatchObject({
      levels: ['provider', 'platform', 'project', 'workspace', 'global'],
      observeSeconds: 90,
      targets: {},
    });
  });

  it('rejects bad rehearse input', () => {
    expect(() => parseGateArgs(['--rehearse'])).toThrow('kill-switch, rollback or all');
    expect(() => parseGateArgs(['--rehearse', 'all', '--levels', 'moon'])).toThrow('unknown level');
    expect(() => parseGateArgs(['--rehearse', 'rollback', '--to-tag', 'x;rm -rf /'])).toThrow(
      'invalid image tag',
    );
    expect(() => parseGateArgs(['--rehearse', 'all', '--observe-seconds', '30'])).toThrow(
      'at least 60',
    );
  });

  it('parses snapshot and restore-check with ISO times', () => {
    expect(parseGateArgs(['--snapshot'])).toMatchObject({
      kind: 'snapshot',
      snapshotFile: DEFAULT_SNAPSHOT_FILE,
    });
    expect(
      parseGateArgs([
        '--restore-check',
        '--snapshot-file',
        's.json',
        '--incident-at',
        '2026-09-28T10:00:00Z',
        '--restore-started-at',
        '2026-09-28T10:05:00+01:00',
      ]),
    ).toMatchObject({
      kind: 'restore-check',
      snapshotFile: 's.json',
      incidentAt: '2026-09-28T10:00:00.000Z',
      restoreStartedAt: '2026-09-28T09:05:00.000Z',
    });
    expect(() => parseGateArgs(['--restore-check', '--incident-at', 'yesterday'])).toThrow('ISO');
    expect(() => parseGateArgs(['--snapshot', 'postgres://x'])).toThrow('unexpected argument');
  });

  it('parses live-providers flags; confirm defaults to false', () => {
    expect(parseGateArgs(['--live-providers'])).toMatchObject({
      kind: 'live-providers',
      confirm: false,
      posts: true,
      providers: true,
    });
    expect(
      parseGateArgs(['--live-providers', '--confirm', '--only', 'runway, tiktok', '--no-posts']),
    ).toMatchObject({ confirm: true, only: ['runway', 'tiktok'], posts: false });
  });

  it('parses corpus-preflight', () => {
    expect(parseGateArgs(['--corpus-preflight', 'c.csv', '--sample', '100'])).toMatchObject({
      kind: 'corpus-preflight',
      manifest: 'c.csv',
      sample: 100,
      workers: 1,
    });
    expect(() => parseGateArgs(['--corpus-preflight'])).toThrow('manifest path');
    expect(() => parseGateArgs(['--corpus-preflight', 'c.csv', '--workers', '0'])).toThrow(
      'whole number',
    );
  });

  it('needs exactly one check and known flags', () => {
    expect(() => parseGateArgs([])).toThrow(ValidationError);
    expect(() => parseGateArgs(['--k6', 'smoke', '--snapshot'])).toThrow('one check');
    expect(() => parseGateArgs(['--k6', 'smoke', '--bogus'])).toThrow('unknown argument');
    expect(() => parseGateArgs(['--k6', 'smoke', '--operator'])).toThrow('needs a value');
  });
});
