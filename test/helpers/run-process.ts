import { spawn } from 'node:child_process';

// Runs a child process without blocking the test worker's event loop (spawnSync starves vitest's
// RPC on slow machines), collecting its exit status and output.

export interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** Runs a TypeScript script with tsx (node --import tsx). */
export function runTsx(
  script: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessResult> {
  return runProcess(process.execPath, ['--import', 'tsx', script, ...args], options);
}
