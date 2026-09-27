import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigurationError, ValidationError } from '../../src/lib/errors';
import { logger } from '../../src/lib/logger';
import {
  categorySlugsFromTree,
  emptyState,
  formatFromPath,
  loadState,
  parseManifest,
  pendingRows,
  seededRandom,
  stateCounts,
  stratifiedSample,
  validateRows,
  type CorpusState,
  type ManifestRow,
} from '../../src/lib/studio/library/corpus-manifest';
import {
  estimate,
  formatDistribution,
  formatErrors,
  formatEstimate,
  formatReviewReport,
  parseCorpusArgs,
  type CorpusArgs,
} from '../../src/lib/studio/library/corpus-report';
import {
  createStudioClient,
  submitRows,
  waitForRuns,
  type StudioClient,
} from '../../src/lib/studio/library/corpus-run';

// BACKLOG 9.2 / 9.3 — ingest the library corpus through the admin API
// (runbooks/corpus-ingestion.md). Dry run by default; --apply submits.
//
//   STUDIO_URL=https://studio.postmind.ai STUDIO_STAFF_TOKEN=<staff JWT> \
//   npx tsx scripts/ops/ingest-corpus.ts corpus.csv [--sample 100 [--seed 7]] [--apply]
//     [--state corpus.csv.state.json] [--concurrency 2] [--queue-concurrency 2] [--workers 1]
//     [--minutes-per-video 3] [--license-source "…"] [--wait-minutes 180] [--report]
//
// Manifest: CSV (header row) or JSONL with url (https:// or s3://), title, tags (a|b|c or an
// array), category (slug from GET /library/categories), sourceRef (external id), language.
// Every item is sent as licenseScenario NOT_REQUIRED with --license-source recorded as the audit
// trail (operator decision 2026-09-27: the corpus needs no licence).

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigurationError(`Missing required environment variable ${name}`);
  return value;
}

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function readState(path: string, manifest: string): CorpusState {
  if (!existsSync(path)) return emptyState(manifest);
  return loadState(JSON.parse(readFileSync(path, 'utf8')) as unknown, manifest);
}

/** Atomic write (tmp + rename) so a crash mid-write never corrupts the resume state. */
function saveState(path: string, state: CorpusState): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${path}.tmp`, path);
}

async function sampleReport(
  client: StudioClient,
  args: CorpusArgs,
  rows: ManifestRow[],
  state: CorpusState,
  studioUrl: string,
): Promise<void> {
  const runIdByUrl = new Map(
    rows.flatMap((r) => {
      const runId = state.rows[r.url]?.runId;
      return runId ? [[r.url, runId] as const] : [];
    }),
  );
  out(`Waiting up to ${args.waitMinutes} min for ${runIdByUrl.size} ingest runs…`);
  const { runs, timedOut } = await waitForRuns(client, [...runIdByUrl.values()], {
    pollMs: 30_000,
    timeoutMs: args.waitMinutes * 60_000,
    sleep: (ms) => delay(ms),
    now: Date.now,
    onPoll: (r) =>
      out(
        `  ${r.filter((x) => ['SUCCEEDED', 'DUPLICATE', 'FAILED'].includes(x.state)).length}/${runIdByUrl.size} finished`,
      ),
  });
  out(
    formatReviewReport({
      studioUrl,
      rows: rows.filter((r) => runIdByUrl.has(r.url)),
      runs,
      runIdByUrl,
      random: seededRandom(args.seed + 1),
      timedOut,
    }),
  );
}

async function main(): Promise<void> {
  const args = parseCorpusArgs(process.argv.slice(2));
  const statePath = args.statePath ?? `${args.manifest}.state.json`;
  const studioUrl = env('STUDIO_URL');
  const client = createStudioClient({
    baseUrl: studioUrl,
    token: env('STUDIO_STAFF_TOKEN'),
    fetchImpl: globalThis.fetch,
  });

  const parsed = parseManifest(readFileSync(args.manifest, 'utf8'), formatFromPath(args.manifest));
  const categories = categorySlugsFromTree(await client.categories());
  const { valid, errors } = validateRows(parsed.rows, categories);
  const allErrors = [...parsed.errors, ...errors].sort((a, b) => a.line - b.line);
  let state = readState(statePath, args.manifest);

  if (args.reportOnly) {
    const sampled = valid.filter((r) => state.rows[r.url]?.sample);
    await sampleReport(
      client,
      { ...args, waitMinutes: 0 },
      sampled.length ? sampled : valid,
      state,
      studioUrl,
    );
    return;
  }

  const target = args.sample
    ? stratifiedSample(pendingRows(valid, state), args.sample, seededRandom(args.seed))
    : pendingRows(valid, state);
  const counts = stateCounts(state);
  out(
    `Manifest ${args.manifest}: ${parsed.rows.length + parsed.errors.length} rows, ${valid.length} valid.`,
  );
  out(formatErrors(allErrors));
  out(
    `State ${statePath}: ${counts.accepted} accepted, ${counts.skipped} already ingested, ${counts.rejected} rejected earlier.`,
  );
  out(
    `${args.sample ? `Sample of ${target.length}` : `${target.length} rows`} to submit, by category:`,
  );
  out(formatDistribution(target) || '  (none)');
  out(formatEstimate(estimate(target.length, args), args.minutesPerVideo));

  if (allErrors.length > 0 && !args.sample)
    throw new ValidationError('Fix the invalid rows before a full run (or remove them)');
  if (!args.apply) {
    out('\nDRY RUN — nothing submitted. Re-run with --apply to ingest.');
    return;
  }
  if (target.length === 0) {
    out('Nothing to submit.');
    return;
  }

  state = await submitRows(target, state, {
    client,
    licence: { scenario: 'NOT_REQUIRED', source: args.licenseSource },
    concurrency: args.concurrency,
    maxRetries: 6,
    sleep: (ms) => delay(ms),
    random: Math.random,
    now: () => new Date(),
    sample: Boolean(args.sample),
    onBatch: async (next, done, total) => {
      saveState(statePath, next);
      out(`  submitted ${done}/${total}`);
    },
  });
  const after = stateCounts(state);
  const submittedNow = target.filter((r) => state.rows[r.url]?.status !== 'rejected').length;
  out(
    `Submitted ${submittedNow}/${target.length}. State: ${after.accepted} accepted, ${after.skipped} already ingested, ${after.rejected} rejected (re-run to retry).`,
  );
  const rejected = target.filter((r) => state.rows[r.url]?.status === 'rejected');
  if (rejected.length > 0)
    out(
      formatErrors(
        rejected.map((r) => ({
          line: r.line,
          url: r.url,
          error: state.rows[r.url]?.error ?? 'rejected',
        })),
      ),
    );

  if (args.sample) await sampleReport(client, args, target, state, studioUrl);
  else
    out(
      `Monitor: GET ${studioUrl}/api/studio/admin/library/ingest/status or the admin Library tab.`,
    );
}

main().catch((err: unknown) => {
  logger.error({ err }, 'ingest-corpus failed');
  process.exit(1);
});
