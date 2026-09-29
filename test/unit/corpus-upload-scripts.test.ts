import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProcess } from '../helpers/run-process';

// Phase 19 Track 1 — scripts/corpus/upload.sh and upload.ps1 build the right rclone command.
// rclone is replaced by a stub that records its arguments; nothing is uploaded.

const REPO = join(__dirname, '..', '..');
const SH = join(REPO, 'scripts', 'corpus', 'upload.sh');
const PS1 = join(REPO, 'scripts', 'corpus', 'upload.ps1');
const posix = (p: string) => p.replace(/\\/g, '/');

const hasBash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';
const hasPowerShell =
  process.platform === 'win32' &&
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0']).status === 0;

let work: string;
let source: string;
let list: string;
let conf: string;
let logs: string;
let record: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'corpus-upload-'));
  source = join(work, 'videos');
  mkdirSync(source);
  list = join(work, 'files.txt');
  writeFileSync(list, Array.from({ length: 25 }, (_, i) => `dir ${i}/clip ${i}.mp4\n`).join(''));
  conf = join(work, 'postmind-corpus.conf');
  writeFileSync(conf, '[postmind-corpus]\ntype = s3\n');
  logs = join(work, 'logs');
  record = join(work, 'args.txt');
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

function recordedArgs(): string[] {
  return readFileSync(record, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe('the upload scripts hold no secrets', () => {
  it('neither script reads the R2 key: rclone takes it from the config file', async () => {
    for (const file of [SH, PS1]) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/CORPUS_R2_|secret_access_key|access_key_id/i);
      expect(text).toContain('--config');
      expect(text).toContain('--files-from-raw');
    }
  });
});

describe.skipIf(!hasBash)('upload.sh', { timeout: 60_000 }, () => {
  let stub: string;
  beforeAll(() => {
    stub = join(work, 'rclone-stub.sh');
    writeFileSync(
      stub,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$STUB_OUT"\nexit "${STUB_EXIT:-0}"\n',
    );
    chmodSync(stub, 0o755);
  });

  const run = (args: string[], exit = '0') =>
    runProcess(
      'bash',
      [
        posix(SH),
        '--source',
        posix(source),
        '--files-from',
        posix(list),
        '--config',
        posix(conf),
        '--log-dir',
        posix(logs),
        ...args,
      ],
      { env: { ...process.env, RCLONE: posix(stub), STUB_OUT: posix(record), STUB_EXIT: exit } },
    );

  it('copies the listed files to <remote>:<bucket>/<prefix> with retries and a log', async () => {
    const res = await run([]);
    expect(res.status, res.stderr).toBe(0);
    const args = recordedArgs();
    expect(args.slice(0, 3)).toEqual([
      'copy',
      posix(source),
      'postmind-corpus:eu-corpus-source/videos',
    ]);
    expect(valueAfter(args, '--files-from-raw')).toBe(posix(list));
    expect(valueAfter(args, '--config')).toBe(posix(conf));
    expect(valueAfter(args, '--transfers')).toBe('8');
    expect(valueAfter(args, '--checkers')).toBe('16');
    expect(valueAfter(args, '--retries')).toBe('5');
    expect(args).toContain('--progress');
    expect(valueAfter(args, '--log-file')).toMatch(/upload-\d{8}-\d{6}\.log$/);
    expect(args).not.toContain('--dry-run');
    expect(res.stdout).toContain('Uploading 25 files');
    expect(res.stdout).toContain('OK: finished.');
  });

  it('--test copies only the first 20 files of the list', async () => {
    expect((await run(['--test', '--prefix', '/corpus/2026/'])).status).toBe(0);
    const args = recordedArgs();
    expect(args[2]).toBe('postmind-corpus:eu-corpus-source/corpus/2026');
    const batch = valueAfter(args, '--files-from-raw') as string;
    expect(batch).not.toBe(posix(list));
    const lines = readFileSync(batch, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('dir 0/clip 0.mp4');
  });

  it('--verify runs a one-way rclone check; --quick compares sizes only', async () => {
    expect((await run(['--verify', '--quick'])).status).toBe(0);
    const args = recordedArgs();
    expect(args[0]).toBe('check');
    expect(args).toContain('--one-way');
    expect(args).toContain('--size-only');
    expect(valueAfter(args, '--missing-on-dst')).toMatch(/-missing\.txt$/);
    expect(valueAfter(args, '--differ')).toMatch(/-different\.txt$/);
  });

  it('passes rclone failures through and says a re-run resumes', async () => {
    const res = await run([], '3');
    expect(res.status).toBe(3);
    expect(res.stdout).toContain('run the same command again');
  });

  it('stops with a plain message when the config is missing', async () => {
    const res = await runProcess(
      'bash',
      [
        posix(SH),
        '--source',
        posix(source),
        '--files-from',
        posix(list),
        '--config',
        posix(join(work, 'none.conf')),
      ],
      { env: { ...process.env, RCLONE: posix(stub), STUB_OUT: posix(record) } },
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('npm run corpus:rclone-config');
  });
});

describe.skipIf(!hasPowerShell)('upload.ps1 (Windows PowerShell 5.1)', () => {
  let stub: string;
  beforeAll(() => {
    stub = join(work, 'rclone-stub.ps1');
    writeFileSync(
      stub,
      '[System.IO.File]::WriteAllLines($env:STUB_OUT, [string[]]$args)\nexit [int]$env:STUB_EXIT\n',
    );
  });

  const run = (args: string[], exit = '0') =>
    runProcess(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        PS1,
        '-Source',
        source,
        '-FilesFrom',
        list,
        '-Config',
        conf,
        '-LogDir',
        logs,
        '-RcloneExe',
        stub,
        ...args,
      ],
      { env: { ...process.env, STUB_OUT: record, STUB_EXIT: exit } },
    );

  it('copies the listed files with retries and a log', async () => {
    const res = await run([]);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const args = recordedArgs();
    expect(args.slice(0, 3)).toEqual(['copy', source, 'postmind-corpus:eu-corpus-source/videos']);
    expect(valueAfter(args, '--files-from-raw')).toBe(list);
    expect(valueAfter(args, '--config')).toBe(conf);
    expect(valueAfter(args, '--transfers')).toBe('8');
    expect(args).toContain('--progress');
    expect(res.stdout).toContain('Uploading 25 files');
  }, 60_000);

  it('-Test writes a 20-line batch without a BOM or CR', async () => {
    expect((await run(['-Test'])).status).toBe(0);
    const batch = valueAfter(recordedArgs(), '--files-from-raw') as string;
    const bytes = readFileSync(batch);
    expect(bytes[0]).not.toBe(0xef);
    expect(bytes.includes(0x0d)).toBe(false);
    expect(bytes.toString('utf8').split('\n').filter(Boolean)).toHaveLength(20);
  }, 60_000);

  it('-Verify runs a one-way check and passes failures through', async () => {
    const res = await run(['-Verify'], '1');
    expect(res.status).toBe(1);
    const args = recordedArgs();
    expect(args[0]).toBe('check');
    expect(args).toContain('--one-way');
    expect(args).not.toContain('--size-only');
    expect(res.stdout).toContain('run the same command again');
  }, 60_000);
});
