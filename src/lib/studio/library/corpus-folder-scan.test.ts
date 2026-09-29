import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runTsx } from '../../../../test/helpers/run-process';
import { acceptedExtensions, parseUploadList } from './corpus-folder';
import {
  buildScanReport,
  formatBytes,
  formatHours,
  formatScanSummary,
  R2_PRICING,
  r2Cost,
  uploadHours,
} from './corpus-folder-report';
import { quickHash, scanFolder, uploadSelection, walkFolder } from './corpus-folder-scan';
import { assertOutside, isInside, listOption, parseArgs } from './corpus-cli-args';
import { parseManifest, validateRows } from './corpus-manifest';

const REPO = join(__dirname, '..', '..', '..', '..');
const MIB = 1024 * 1024;

let work: string;
let folder: string;

function put(rel: string, body: Buffer | string): void {
  const path = join(folder, ...rel.split('/'));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

/** Every file with its size and mtime, to prove the tools change nothing. */
function snapshot(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return snapshot(p);
      const s = statSync(p);
      return [`${p}|${s.size}|${s.mtimeMs}`];
    })
    .sort();
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'corpus-scan-'));
  folder = join(work, 'videos');
  const video = randomBytes(3 * MIB);
  put('Lifestyle/Fitness/TikTok/Morning_run-UK.mp4', video);
  put('random stuff/copy of run.MOV', video); // duplicate content, other name and case
  const differentTail = Buffer.from(video);
  differentTail[differentTail.length - 1] = ((differentTail.at(-1) ?? 0) + 1) % 256;
  put('random stuff/same start other end.mp4', differentTail); // same size, not a duplicate
  put('Business/French/pitch deck (French).webm', randomBytes(1_000));
  put('Business/notes.txt', 'not a video');
  put('empty.mp4', '');
  put('random stuff/odd？name.mp4', randomBytes(500));
  put('Café Vidéos/été #1 & more.mp4', randomBytes(700));
  put('Thumbs.db', randomBytes(10));
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('walkFolder and quickHash', () => {
  it('walks nested folders and returns "/" paths in order', async () => {
    const { files, skipped } = await walkFolder(folder);
    expect(files.map((f) => f.relPath)).toEqual([
      'Business/French/pitch deck (French).webm',
      'Business/notes.txt',
      'Café Vidéos/été #1 & more.mp4',
      'Lifestyle/Fitness/TikTok/Morning_run-UK.mp4',
      'Thumbs.db',
      'empty.mp4',
      'random stuff/copy of run.MOV',
      'random stuff/odd？name.mp4',
      'random stuff/same start other end.mp4',
    ]);
    expect(skipped).toEqual([]);
  });

  it('reports a missing folder instead of throwing', async () => {
    const { files, skipped } = await walkFolder(join(work, 'nope'));
    expect(files).toEqual([]);
    expect(skipped[0]?.reason).toMatch(/cannot open folder/);
  });

  it('hashes the first and last MiB: a changed last byte changes it, the middle does not', async () => {
    const a = join(folder, 'Lifestyle/Fitness/TikTok/Morning_run-UK.mp4');
    const b = join(folder, 'random stuff/same start other end.mp4');
    expect(await quickHash(a, 3 * MIB)).not.toBe(await quickHash(b, 3 * MIB));
    const small = join(work, 'small.bin');
    writeFileSync(small, 'abc');
    expect(await quickHash(small, 3)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('scanFolder + report', () => {
  it('classifies, finds the duplicate, and builds the estimates', async () => {
    const scan = await scanFolder(folder, { accepted: acceptedExtensions(), keyPrefix: 'videos/' });
    expect(scan.duplicates).toEqual([
      ['Lifestyle/Fitness/TikTok/Morning_run-UK.mp4', 'random stuff/copy of run.MOV'],
    ]);
    const rejected = Object.fromEntries(
      scan.verdicts.filter((v) => v.reject.length).map((v) => [v.relPath, v.reject]),
    );
    expect(rejected).toEqual({
      'Business/notes.txt': ['unsupported-format'],
      'Thumbs.db': ['system-file'],
      'empty.mp4': ['empty'],
      'random stuff/odd？name.mp4': ['bad-name'],
    });

    const upload = uploadSelection(scan, true);
    expect(upload.map((f) => f.relPath)).toEqual([
      'Business/French/pitch deck (French).webm',
      'Café Vidéos/été #1 & more.mp4',
      'Lifestyle/Fitness/TikTok/Morning_run-UK.mp4',
      'random stuff/same start other end.mp4',
    ]);
    expect(uploadSelection(scan, false)).toHaveLength(5);

    const report = buildScanReport(scan, upload, {
      skipDuplicates: true,
      largest: 2,
      now: new Date('2026-09-29T00:00:00Z'),
    });
    expect(report.totals.files).toBe(9);
    expect(report.byExtension.find((e) => e.ext === 'mp4')?.files).toBe(5);
    expect(report.byExtension.find((e) => e.ext === 'mov')?.files).toBe(1);
    expect(report.largest).toHaveLength(2);
    expect(report.rejectedByReason).toEqual({
      'unsupported-format': 1,
      'system-file': 1,
      empty: 1,
      'bad-name': 1,
    });
    expect(report.duplicates).toMatchObject({ extraCopies: 1, extraBytes: 3 * MIB });
    expect(report.nameWarnings.map((w) => w.relPath)).toEqual(['Café Vidéos/été #1 & more.mp4']);
    expect(report.upload.files).toBe(4);
    expect(report.upload.hours.map((h) => h.mbitPerSec)).toEqual([10, 50, 100]);
    expect(report.upload.r2.pricing.source).toBe('https://developers.cloudflare.com/r2/pricing/');

    const text = formatScanSummary(report);
    expect(text).toContain('Found 9 files');
    expect(text).toContain('Files Studio would refuse (4)');
    expect(text).toContain('Duplicate videos: 1 set, 1 extra copy');
    expect(text).toContain('To upload: 4 videos');
    expect(text).toContain('10 Mbit/s: about');
    expect(text).toContain('read 2026-09-29');
  });
});

describe('estimates', () => {
  it('upload time: 1 GB at 10 Mbit/s is 800 s', () => {
    expect(uploadHours(1e9, 10) * 3600).toBeCloseTo(800);
    expect(formatHours(uploadHours(1e9, 10))).toBe('13 minutes');
    expect(formatHours(5)).toBe('5.0 hours');
    expect(formatHours(72)).toBe('3.0 days');
  });

  it('R2 cost: free 10 GB and 1M uploads, then the published prices', () => {
    expect(R2_PRICING.usdPerGbMonth).toBe(0.015);
    expect(r2Cost(5e9, 100)).toMatchObject({ storageUsdPerMonth: 0, uploadUsd: 0 });
    const big = r2Cost(2_010e9, 50_000);
    expect(big.storageUsdPerMonth).toBeCloseTo(30);
    expect(big.uploadUsd).toBe(0);
    expect(r2Cost(1e9, 2_000_000).uploadUsd).toBeCloseTo(4.5);
  });

  it('formats sizes in decimal units', () => {
    expect(formatBytes(999)).toBe('999 bytes');
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
    expect(formatBytes(2.5e12)).toBe('2.5 TB');
  });
});

describe('CLI argument helpers', () => {
  it('parses flags, values and positionals and refuses unknown options', () => {
    const args = parseArgs(['dir', '--out', 'r.json', '--skip-duplicates'], {
      valueOptions: ['--out'],
      flagOptions: ['--skip-duplicates'],
    });
    expect(args.positional).toEqual(['dir']);
    expect(args.values.get('--out')).toBe('r.json');
    expect(args.flags.has('--skip-duplicates')).toBe(true);
    expect(() => parseArgs(['--bogus'], { valueOptions: [], flagOptions: [] })).toThrow(
      /unknown option/,
    );
    expect(() => parseArgs(['--out'], { valueOptions: ['--out'], flagOptions: [] })).toThrow(
      /needs a value/,
    );
    expect(listOption(' mkv, .m4v ,')).toEqual(['mkv', '.m4v']);
  });

  it('refuses output inside the video folder', () => {
    expect(isInside('/a/b', '/a/b/c.json')).toBe(true);
    expect(isInside('/a/b', '/a/bc.json')).toBe(false);
    expect(() => assertOutside('/a/b', '/a/b/x.csv')).toThrow(/outside the video folder/);
  });
});

function runTool(script: string, args: string[]) {
  return runTsx(join(REPO, script), args, {
    cwd: REPO,
    env: { ...process.env, LOG_LEVEL: 'silent' },
  });
}

describe('scan-folder.ts and manifest-from-folder.ts (end to end)', () => {
  it('scan writes the report and upload list; manifest matches it and passes the validator; the folder is untouched', async () => {
    const before = snapshot(folder);
    const report = join(work, 'scan.json');
    const list = join(work, 'files.txt');
    const csv = join(work, 'corpus.csv');

    const scan = await runTool('scripts/corpus/scan-folder.ts', [
      folder,
      '--out',
      report,
      '--upload-list',
      list,
      '--skip-duplicates',
    ]);
    expect(scan.status, scan.stderr).toBe(0);
    expect(scan.stdout).toContain('Files Studio would refuse (4)');
    expect(JSON.parse(readFileSync(report, 'utf8')).upload.files).toBe(4);
    const listed = parseUploadList(readFileSync(list, 'utf8'));
    expect(listed).toHaveLength(4);

    const manifest = await runTool('scripts/corpus/manifest-from-folder.ts', [
      folder,
      '--bucket',
      'eu-corpus-source',
      '--prefix',
      'videos/',
      '--out',
      csv,
      '--upload-list',
      list,
      '--skip-duplicates',
    ]);
    expect(manifest.status, manifest.stdout + manifest.stderr).toBe(0);
    expect(manifest.stdout).toContain('4 of 4 rows valid');
    expect(manifest.stdout).toContain('Every row matches a file in the upload list');

    const parsed = parseManifest(readFileSync(csv, 'utf8'), 'csv');
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => r.url)).toEqual(
      listed.map((p) => `s3://eu-corpus-source/videos/${p}`),
    );
    const lifestyle = parsed.rows.find((r) => r.url.includes('Morning_run'));
    expect(lifestyle).toMatchObject({
      title: 'Morning run UK',
      tags: ['lifestyle', 'fitness', 'tiktok'],
      category: 'lifestyle/fitness',
      sourcePlatform: 'tiktok',
    });
    expect(parsed.rows.find((r) => r.url.includes('pitch deck'))?.language).toBe('fr');
    expect(validateRows(parsed.rows, new Set(['lifestyle/fitness', 'business'])).errors).toEqual(
      [],
    );

    expect(snapshot(folder)).toEqual(before);
  }, 60_000);

  it('manifest fails when the options differ from the upload list', async () => {
    const list = join(work, 'files-all.txt');
    expect(
      (await runTool('scripts/corpus/scan-folder.ts', [folder, '--upload-list', list])).status,
    ).toBe(0);
    const res = await runTool('scripts/corpus/manifest-from-folder.ts', [
      folder,
      '--bucket',
      'eu-corpus-source',
      '--prefix',
      'videos/',
      '--out',
      join(work, 'c2.csv'),
      '--upload-list',
      list,
      '--skip-duplicates',
    ]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('The manifest and the upload list differ');
    expect(res.stdout).toContain('no row:       random stuff/copy of run.MOV');
  }, 60_000);

  it('refuses to write inside the scanned folder', async () => {
    const res = await runTool('scripts/corpus/scan-folder.ts', [
      folder,
      '--out',
      join(folder, 'report.json'),
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('outside the video folder');
  }, 60_000);
});
