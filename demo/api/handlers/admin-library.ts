// /admin/library/* (agent "insight"): staff ingest, ingest monitoring, edit and retire.
import { DemoHttpError, route } from '../registry';
import { categoryName, type LicenseScenario } from './library-data';
import {
  anyItem,
  enqueueIngest,
  ingestRuns,
  libraryItems,
  patchItem,
  type IngestRequest,
  type RunState,
} from './library-store';

const HOUR = 3_600_000;
const SCENARIOS: LicenseScenario[] = ['LICENSED', 'OWNED', 'SCRAPED', 'NOT_REQUIRED'];

// Two jobs already in flight when the demo opens, so the status card shows a live backlog.
enqueueIngest([
  {
    sourceUrl: 'https://www.tiktok.com/@yorkshirecrumb/video/7420',
    licenseScenario: 'LICENSED',
    licenseSource: 'Creator agreement CA-2026-071',
    category: 'business/local-business/bakeries',
    tags: ['bakery', 'bread'],
    title: 'Scoring patterns in 20 seconds',
  },
  {
    sourceUrl: 'https://www.instagram.com/reel/DAcafe-queue',
    licenseScenario: 'SCRAPED',
    category: 'business/local-business/cafes',
    tags: ['cafe', 'queue'],
    title: 'The Saturday queue, explained',
  },
]);

route('POST', '/admin/library/ingest', ({ body }) => {
  const items = (body as { items?: IngestRequest[] } | undefined)?.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 100)
    throw new DemoHttpError(400, 'validation_error', 'items must contain 1–100 sources');
  for (const item of items) {
    if (!SCENARIOS.includes(item.licenseScenario))
      throw new DemoHttpError(400, 'validation_error', 'Unknown licence scenario');
    if (item.category && !categoryName(item.category))
      throw new DemoHttpError(400, 'validation_error', `Unknown category slug ${item.category}`);
  }
  return { status: 202, body: enqueueIngest(items) };
});

route('GET', '/admin/library/ingest/status', ({ query }) => {
  const windowHours = Math.min(24 * 30, Math.max(1, Number(query.get('windowHours') ?? 24) || 24));
  const failures = Math.min(100, Math.max(0, Number(query.get('failures') ?? 20) || 20));
  const now = Date.now();
  const since = now - windowHours * HOUR;
  const runs = ingestRuns();
  const inWindow = runs.filter((r) => r.updatedAt >= since);
  const counts: Record<RunState, number> = {
    QUEUED: 0,
    RUNNING: 0,
    SUCCEEDED: 0,
    DUPLICATE: 0,
    FAILED: 0,
  };
  for (const r of inWindow) counts[r.state] += 1;
  const completed = counts.SUCCEEDED + counts.DUPLICATE + counts.FAILED;
  return {
    windowHours,
    since: new Date(since).toISOString(),
    counts,
    total: inWindow.length,
    completedPerHour: Math.round((completed / windowHours) * 100) / 100,
    backlog: {
      queued: runs.filter((r) => r.state === 'QUEUED').length,
      running: runs.filter((r) => r.state === 'RUNNING').length,
    },
    liveLibraryItems: libraryItems().length,
    recentFailures: runs
      .filter((r) => r.state === 'FAILED' && (r.finishedAt ?? 0) >= since)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
      .slice(0, failures)
      .map((r) => ({
        runId: r.runId,
        sourceUrl: r.sourceUrl,
        sourceRef: r.sourceRef,
        errorReason: r.errorReason,
        attempts: r.attempts,
        finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
      })),
  };
});

interface PatchBody {
  title?: string;
  description?: string | null;
  category?: string;
  tags?: string[];
  licenseScenario?: LicenseScenario;
  licenseSource?: string | null;
}

route('PATCH', '/admin/library/videos/:id', ({ params, body }) => {
  const id = params.id ?? '';
  const item = anyItem(id);
  if (!item) throw new DemoHttpError(404, 'not_found', 'Library video not found');
  const input = (body ?? {}) as PatchBody;
  if (Object.keys(input).length === 0)
    throw new DemoHttpError(400, 'validation_error', 'Nothing to update');
  if (input.category && !categoryName(input.category))
    throw new DemoHttpError(400, 'validation_error', 'Unknown category slug');
  if (input.licenseScenario && !SCENARIOS.includes(input.licenseScenario))
    throw new DemoHttpError(400, 'validation_error', 'Unknown licence scenario');
  const scenario = input.licenseScenario ?? item.scenario;
  const updated = patchItem(id, {
    ...(input.title !== undefined && { title: input.title.trim() }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.category && { categorySlug: input.category }),
    ...(input.tags && { tags: [...new Set(input.tags.map((t) => t.toLowerCase()))] }),
    scenario,
    ...(input.licenseSource !== undefined
      ? { licenseSource: input.licenseSource }
      : scenario === 'NOT_REQUIRED' && !item.licenseSource
        ? { licenseSource: 'Operator decision (staff: demo)' }
        : {}),
  });
  if (!updated) throw new DemoHttpError(404, 'not_found', 'Library video not found');
  return {
    video: {
      id: updated.id,
      title: updated.title,
      description: updated.description,
      tags: updated.tags,
      durationSec: updated.durationSec,
      aspectRatio: updated.aspectRatio,
      sourcePlatform: updated.sourcePlatform,
      ingestedAt: updated.ingestedAt,
      retiredAt: updated.retiredAt,
    },
  };
});

route('POST', '/admin/library/videos/:id/retire', ({ params }) => {
  const id = params.id ?? '';
  const item = anyItem(id);
  if (!item || item.retiredAt)
    throw new DemoHttpError(404, 'not_found', 'Library video not found or already retired');
  patchItem(id, { retiredAt: new Date().toISOString() });
  return { retired: true };
});
