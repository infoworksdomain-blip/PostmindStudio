import { StudioError } from '../../src/lib/errors';
import { logger } from '../../src/lib/logger';
import { parseGateArgs, type GateCommand } from '../../src/lib/studio/ops/staging-gate/args';
import { preflightSections } from '../../src/lib/studio/ops/staging-gate/corpus-preflight';
import type { GateReport } from '../../src/lib/studio/ops/staging-gate/report';
import {
  baseContext,
  NEEDS_SHELL_FOR_NPM,
  out,
  runProcess,
  writeReport,
} from './staging-gate/common';
import { runK6 } from './staging-gate/k6';
import { runLiveProviders } from './staging-gate/live';
import { runRehearse } from './staging-gate/rehearse';
import { runRestoreCheck, runSnapshot } from './staging-gate/restore';

// Phase 14.5–14.9 — the staging gate (GATE 12). One command per check; each writes
// ops/results/<date>-<check>.json + .md. Order and the results table: runbooks/staging-gate.md.
// Manual trigger in CI: .github/workflows/staging-gate.yml.
//
//   npx tsx scripts/ops/staging-gate.ts --k6 smoke|full
//   npx tsx scripts/ops/staging-gate.ts --rehearse kill-switch|rollback|all [...]
//   npx tsx scripts/ops/staging-gate.ts --snapshot            (before a restore drill)
//   npx tsx scripts/ops/staging-gate.ts --restore-check [...] (after it, DATABASE_URL=restored)
//   npx tsx scripts/ops/staging-gate.ts --live-providers [--confirm]   (= npm run gate:live)
//   npx tsx scripts/ops/staging-gate.ts --corpus-preflight corpus.csv [--sample 100]

async function corpusPreflight(
  cmd: Extract<GateCommand, { kind: 'corpus-preflight' }>,
): Promise<GateReport> {
  const startedAt = new Date().toISOString();
  const args = [
    'tsx',
    'scripts/ops/ingest-corpus.ts',
    cmd.manifest,
    '--preflight',
    '--workers',
    String(cmd.workers),
    ...(cmd.sample ? ['--sample', String(cmd.sample)] : []),
  ];
  const run = await runProcess('npx', args, { shell: NEEDS_SHELL_FOR_NPM });
  const mode = cmd.sample ? `sample-${cmd.sample}` : 'full';
  return {
    check: `corpus-preflight-${cmd.sample ? 'sample' : 'full'}`,
    title: `Corpus pre-flight, ${mode} (14.9)`,
    verdict: run.exitCode === 0 ? 'PASS' : 'FAIL',
    startedAt,
    finishedAt: new Date().toISOString(),
    context: { ...baseContext(cmd.operator), Manifest: cmd.manifest },
    sections: preflightSections(run.output, run.exitCode),
    data: { exitCode: run.exitCode },
  };
}

async function run(cmd: GateCommand): Promise<GateReport | null> {
  switch (cmd.kind) {
    case 'k6':
      return runK6(cmd.mode, cmd.outDir, cmd.operator);
    case 'rehearse':
      return runRehearse(cmd);
    case 'snapshot':
      return runSnapshot(cmd);
    case 'restore-check':
      return runRestoreCheck(cmd);
    case 'live-providers':
      return runLiveProviders(cmd);
    case 'corpus-preflight':
      return corpusPreflight(cmd);
  }
}

async function main(): Promise<void> {
  const cmd = parseGateArgs(process.argv.slice(2));
  const report = await run(cmd);
  if (!report) {
    process.exitCode = 2; // refused (no --confirm): nothing ran
    return;
  }
  writeReport(report, cmd.outDir);
  process.exitCode = report.verdict === 'PASS' ? 0 : 1;
}

main().catch((err: unknown) => {
  if (err instanceof StudioError) out(`✗ ${err.name}: ${err.message}`);
  else logger.error({ err }, 'staging gate failed');
  process.exitCode = 1;
});
