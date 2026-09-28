import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { ConfigurationError } from '../../../src/lib/errors';
import type { K6Mode } from '../../../src/lib/studio/ops/staging-gate/args';
import {
  evaluateThresholds,
  K6_INSTALL_HINT,
  k6RunArgs,
  k6Sections,
  missingK6Env,
  parseSummaryExport,
  succeededJobs,
  throughputBetween,
  type K6Metrics,
  type Throughput,
} from '../../../src/lib/studio/ops/staging-gate/k6';
import { redactUrl, type GateReport } from '../../../src/lib/studio/ops/staging-gate/report';
import { baseContext, optionalEnv, out, runProcess } from './common';

// 14.5 — `staging-gate.ts --k6 smoke|full`. Env: BASE_URL (staging), STUDIO_TOKEN (load-test org
// JWT), optional BUSINESS_ID + WRITES=1, TARGET_VUS, K6_BIN, METRICS_URL + METRICS_TOKEN (queue
// throughput during the run).

function k6Binary(): string {
  const binary = optionalEnv('K6_BIN') ?? 'k6';
  const probe = spawnSync(binary, ['version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) throw new ConfigurationError(K6_INSTALL_HINT);
  out(`Using ${probe.stdout.trim()}`);
  return binary;
}

async function scrapeJobs(): Promise<Record<string, number> | undefined> {
  const url = optionalEnv('METRICS_URL');
  const token = optionalEnv('METRICS_TOKEN');
  if (!url || !token) return undefined;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    out(`metrics scrape failed (${res.status}); throughput not measured`);
    return undefined;
  }
  return succeededJobs(await res.text());
}

export async function runK6(mode: K6Mode, outDir: string, operator?: string): Promise<GateReport> {
  const missing = missingK6Env(process.env);
  if (missing.length) {
    throw new ConfigurationError(`Missing ${missing.join(', ')} (staging URL and load-test JWT)`);
  }
  const binary = k6Binary();
  mkdirSync(outDir, { recursive: true });
  const startedAt = new Date();
  const summaryFile = `${outDir}/${startedAt.toISOString().slice(0, 10)}-k6-${mode}.summary.json`;
  const before = await scrapeJobs();
  const run = await runProcess(binary, k6RunArgs(mode, summaryFile));
  const after = before ? await scrapeJobs() : undefined;

  let metrics: K6Metrics = {};
  let parseError: string | undefined;
  try {
    metrics = parseSummaryExport(JSON.parse(readFileSync(summaryFile, 'utf8')) as unknown);
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }
  const throughput: Throughput | undefined =
    before && after ? throughputBetween(before, after, run.durationMs) : undefined;
  const { verdict, sections } = k6Sections({
    mode,
    exitCode: run.exitCode,
    results: evaluateThresholds(metrics),
    metrics,
    throughput,
  });
  if (parseError) {
    sections.unshift({
      title: 'Summary export',
      verdict: 'FAIL',
      lines: [`Could not read ${summaryFile}: ${parseError}`],
    });
  }
  return {
    check: `k6-${mode}`,
    title: `k6 ${mode} run (14.5)`,
    verdict: parseError ? 'FAIL' : verdict,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    context: {
      ...baseContext(operator),
      Target: redactUrl(process.env.BASE_URL ?? ''),
      Writes: process.env.WRITES === '1' ? 'on (draft projects only)' : 'off',
      'Summary export': summaryFile,
    },
    sections,
    data: { exitCode: run.exitCode, metrics, throughput: throughput ?? null },
  };
}
