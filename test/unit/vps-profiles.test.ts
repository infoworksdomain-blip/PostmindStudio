import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProcess } from '../helpers/run-process';

// scripts/vps/lib.sh vps_profiles feeds `mapfile` in compose.sh and deploy.sh. With no optional
// profile it must print nothing: an empty line became an empty argument and every
// `compose.sh production …` failed with "unknown docker command" on the first server (2026-09-30).

const LIB = join(__dirname, '..', '..', 'scripts', 'vps', 'lib.sh');
const posix = (p: string) => p.replace(/\\/g, '/');
const hasBash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'vps-profiles-'));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

async function profiles(envText: string): Promise<string[]> {
  const envFile = join(work, `${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(envFile, envText);
  const script = [
    `source '${posix(LIB)}' >/dev/null 2>&1`,
    `ENV_FILE='${posix(envFile)}'`,
    'mapfile -t p < <(vps_profiles)',
    'echo "${#p[@]}"',
    'for x in "${p[@]+"${p[@]}"}"; do printf "[%s]\\n" "$x"; done',
  ].join('\n');
  const result = await runProcess('bash', ['-c', script]);
  expect(result.status).toBe(0);
  const [count, ...items] = result.stdout.trim().split(/\r?\n/);
  expect(items.length).toBe(Number(count));
  return items.map((item) => item.slice(1, -1));
}

describe.skipIf(!hasBash)('vps_profiles (scripts/vps/lib.sh)', { timeout: 60_000 }, () => {
  it('prints nothing when no optional profile is on', async () => {
    expect(await profiles('STUDIO_MONITORING=off\n')).toEqual([]);
    expect(await profiles('')).toEqual([]);
  });

  it('prints each enabled profile as a --profile pair', async () => {
    expect(await profiles('STUDIO_MONITORING=on\nHEADLESS_RENDER=on\n')).toEqual([
      '--profile',
      'monitoring',
      '--profile',
      'headless-render',
    ]);
  });
});
