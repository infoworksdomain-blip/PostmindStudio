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
import { parseS3Url } from '../../src/lib/studio/library/corpus-source';
import {
  evaluatePreflight,
  formatPreflight,
  preflightVerdict,
  s3ProbeRows,
} from '../../src/lib/studio/ops/staging-gate/corpus-preflight';
import { getAssetStorage } from '../../src/lib/studio/storage';

// BACKLOG 9.2 / 9.3 — ingest the library corpus through the admin API
// (runbooks/corpus-ingestion.md). Dry run by default; --apply submits.
//
//   STUDIO_URL=https://studio.postmind.ai STUDIO_STAFF_TOKEN=<staff JWT> \
//   npx tsx scripts/ops/ingest-corpus.ts corpus.csv [--sample 100 [--seed 7]] [--apply]
//     [--state corpus.csv.state.json] [--concurrency 2] [--queue-concurrency 2] [--workers 1]
//     [--minutes-per-video 3] [--license-source "…"] [--wait-minutes 180] [--report]
//   … corpus.csv --preflight [--sample 100] [--workers 2]   (14.9: checks only, submits nothing)
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

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Write + delete a tiny object under library/staging/ (expired by the S3 lifecycle rule). */
async function probeLibraryBucket(): Promise<{ ok: boolean; detail: string } | null> {
  const bucket = process.env.S3_BUCKET_LIBRARY?.trim();
  if (!bucket) return null;
  const key = `library/staging/preflight-${Date.now()}.txt`;
  try {
    const storage = getAssetStorage();
    await storage.put({
      bucket,
      key,
      body: new TextEncoder().encode('ingest-corpus pre-flight probe'),
      contentType: 'text/plain',
    });
    await storage.delete(bucket, key);
    return { ok: true, detail: `write + delete OK in s3://${bucket}/library/staging/` };
  } catch (err) {
    return { ok: false, detail: `s3://${bucket}: ${errMsg(err)}` };
  }
}

async function probeS3Sources(
  rows: ManifestRow[],
): Promise<Array<{ url: string; ok: boolean; detail: string }>> {
  const probes = [];
  for (const row of s3ProbeRows(rows)) {
    try {
      const { bucket, key } = parseS3Url(row.url);
      const bytes = await getAssetStorage().size(bucket, key);
      probes.push({ url: row.url, ok: true, detail: `${bytes} bytes` });
    } catch (err) {
      probes.push({ url: row.url, ok: false, detail: errMsg(err) });
    }
  }
  return probes;
}

async function preflight(args: CorpusArgs, client: StudioClient): Promise<void> {
  const parsed = parseManifest(readFileSync(args.manifest, 'utf8'), formatFromPath(args.manifest));
  let categories: Set<string>;
  let categoriesCheck: { ok: boolean; detail: string };
  try {
    categories = categorySlugsFromTree(await client.categories());
    categoriesCheck = { ok: true, detail: `${categories.size} category slugs` };
  } catch (err) {
    // Without the taxonomy, category slugs can't be checked: accept the manifest's own.
    categories = new Set(parsed.rows.flatMap((r) => (r.category ? [r.category] : [])));
    categoriesCheck = { ok: false, detail: errMsg(err) };
  }
  const { valid, errors } = validateRows(parsed.rows, categories);
  const mode = args.sample ? 'sample' : 'full';
  const checks = evaluatePreflight({
    mode,
    env: process.env,
    workers: args.workers,
    minutesPerVideo: args.minutesPerVideo,
    rows: args.sample ? valid.slice(0, args.sample) : valid,
    errors: [...parsed.errors, ...errors].sort((a, b) => a.line - b.line),
    categories: categoriesCheck,
    libraryBucket: await probeLibraryBucket(),
    s3Probes: await probeS3Sources(valid),
  });
  out(formatPreflight(checks, mode));
  if (preflightVerdict(checks) === 'FAIL') process.exitCode = 1;
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
  if (args.preflight) return preflight(args, client);

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
