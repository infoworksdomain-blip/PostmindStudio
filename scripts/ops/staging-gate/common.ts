import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConfigurationError, UpstreamServiceError } from '../../../src/lib/errors';
import {
  formatMarkdown,
  resultBaseName,
  type GateReport,
} from '../../../src/lib/studio/ops/staging-gate/report';

// Shared I/O for scripts/ops/staging-gate.ts (the pure logic is in src/lib/studio/ops/staging-gate).

export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigurationError(`Missing required environment variable ${name}`);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Writes <outDir>/<date>-<check>.json and .md; returns the base path. */
export function writeReport(report: GateReport, outDir: string): string {
  const base = resultBaseName(report.check, new Date(report.finishedAt), outDir);
  mkdirSync(dirname(base), { recursive: true });
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${base}.md`, formatMarkdown(report));
  out(`\n${report.title}: ${report.verdict}`);
  out(`Report: ${base}.md (+ .json)`);
  return base;
}

export interface ProcessResult {
  exitCode: number;
  output: string;
  durationMs: number;
}

/**
 * Runs a command, streaming its output to ours and capturing it (capped) for the report.
 * `shell: true` only for the operator-owned deploy template (STAGING_DEPLOY_CMD).
 */
export function runProcess(
  command: string,
  args: readonly string[],
  opts: { shell?: boolean; env?: NodeJS.ProcessEnv; captureLimit?: number } = {},
): Promise<ProcessResult> {
  const limit = opts.captureLimit ?? 200_000;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: opts.shell ?? false,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const onData = (chunk: Buffer) => {
      process.stdout.write(chunk);
      if (output.length < limit) output += chunk.toString('utf8');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) =>
      reject(new UpstreamServiceError(`could not start ${command}: ${err.message}`)),
    );
    child.on('close', (code) =>
      resolve({ exitCode: code ?? 1, output, durationMs: Date.now() - started }),
    );
  });
}

/** npm / npx are .cmd shims on Windows, which Node only spawns through a shell (fixed args). */
export const NEEDS_SHELL_FOR_NPM = process.platform === 'win32';

export function baseContext(operator: string | undefined): Record<string, string> {
  return {
    Operator: operator ?? optionalEnv('GATE_OPERATOR') ?? optionalEnv('GITHUB_ACTOR') ?? 'unknown',
    ...(optionalEnv('GITHUB_RUN_ID') && {
      'CI run': `${optionalEnv('GITHUB_SERVER_URL') ?? ''}/${optionalEnv('GITHUB_REPOSITORY') ?? ''}/actions/runs/${optionalEnv('GITHUB_RUN_ID')}`,
    }),
  };
}
