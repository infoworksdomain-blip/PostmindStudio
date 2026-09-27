// In-memory reference corpus (agent "insight"): the live library items plus the ingest-run log the
// Admin Centre monitors. Ingest jobs advance on timers (QUEUED → RUNNING → SUCCEEDED/FAILED) and
// a succeeded run adds a new library item, so the browse screen picks it up.
import type { SceneKind } from '../../media';
import { LIBRARY, type LibraryItem, type LicenseScenario } from './library-data';

const items: LibraryItem[] = LIBRARY.map((i) => ({
  ...i,
  tags: [...i.tags],
  analysis: { ...i.analysis },
}));

export const libraryItems = (): LibraryItem[] => items.filter((i) => !i.retiredAt);
export const liveItem = (id: string): LibraryItem | undefined =>
  items.find((i) => i.id === id && !i.retiredAt);
export const anyItem = (id: string): LibraryItem | undefined => items.find((i) => i.id === id);

export function patchItem(id: string, patch: Partial<LibraryItem>): LibraryItem | undefined {
  const i = items.findIndex((x) => x.id === id);
  const current = items[i];
  if (i < 0 || !current) return undefined;
  const next = { ...current, ...patch, id };
  items[i] = next;
  return next;
}

// ------------------------------------------------------------------ ingest runs

export type RunState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'DUPLICATE' | 'FAILED';

export interface IngestRun {
  runId: string;
  sourceUrl: string;
  sourceRef: string | null;
  state: RunState;
  errorReason: string | null;
  attempts: number;
  updatedAt: number;
  finishedAt: number | null;
  libraryItemId: string | null;
}

const HOUR = 3_600_000;
const now0 = Date.now();

export function runIdFor(url: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1234567;
  for (let i = 0; i < url.length; i++) {
    h1 = Math.imul(h1 ^ url.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + url.charCodeAt(i), 2654435761) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  return (hex(h1) + hex(h2) + hex(h1 ^ h2) + hex((h1 + h2) >>> 0)).slice(0, 32);
}

const runs: IngestRun[] = [
  ...LIBRARY.map((i) => {
    const at = Date.parse(i.ingestedAt);
    return {
      runId: runIdFor(i.sourceUrl),
      sourceUrl: i.sourceUrl,
      sourceRef: `batch-${new Date(at).toISOString().slice(0, 10)}`,
      state: 'SUCCEEDED' as const,
      errorReason: null,
      attempts: 1,
      updatedAt: at,
      finishedAt: at,
      libraryItemId: i.id,
    };
  }),
  ...(
    [
      [
        'https://www.tiktok.com/@crumbandco/video/7401',
        'FAILED',
        'download_failed: source returned 403 (video set to private)',
        3,
        2,
      ],
      [
        'https://www.instagram.com/reel/C9xBakeSale',
        'FAILED',
        'analysis_failed: no scene changes detected (static slideshow)',
        1,
        5,
      ],
      [
        'https://www.youtube.com/shorts/pie-week-0412',
        'FAILED',
        'source_too_long: 184 s exceeds the 120 s corpus limit',
        1,
        19,
      ],
      [
        'https://www.tiktok.com/@northernpantry/video/7390',
        'FAILED',
        'moderation_rejected: Hive flagged alcohol branding',
        1,
        40,
      ],
      ['https://www.tiktok.com/@leedsbakes/video/7322', 'DUPLICATE', null, 1, 3],
      ['https://www.instagram.com/reel/C8croissant-pull', 'DUPLICATE', null, 1, 11],
      ['https://www.youtube.com/shorts/scone-debate', 'DUPLICATE', null, 1, 30],
    ] as Array<[string, RunState, string | null, number, number]>
  ).map(([url, state, reason, attempts, hoursAgo]) => ({
    runId: runIdFor(url),
    sourceUrl: url,
    sourceRef: 'ops-sheet-row',
    state,
    errorReason: reason,
    attempts,
    updatedAt: now0 - hoursAgo * HOUR,
    finishedAt: now0 - hoursAgo * HOUR,
    libraryItemId: null,
  })),
];

export const ingestRuns = (): IngestRun[] => runs.map((r) => ({ ...r }));
export const runFor = (url: string): IngestRun | undefined => runs.find((r) => r.sourceUrl === url);

function setRun(runId: string, patch: Partial<IngestRun>) {
  const i = runs.findIndex((r) => r.runId === runId);
  const cur = runs[i];
  if (i >= 0 && cur) runs[i] = { ...cur, ...patch, updatedAt: Date.now() };
}

export interface IngestRequest {
  sourceUrl: string;
  licenseScenario: LicenseScenario;
  licenseSource?: string;
  category?: string;
  tags: string[];
  title?: string;
  sourcePlatform?: string;
}

const SCENES: SceneKind[] = [
  'sourdough',
  'croissant',
  'coffee',
  'cake',
  'market',
  'kitchen',
  'flatlay',
];

function platformOf(url: string): string | null {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  if (host.includes('tiktok')) return 'tiktok';
  if (host.includes('instagram')) return 'instagram';
  if (host.includes('youtu')) return 'youtube';
  return null;
}

function finish(runId: string, req: IngestRequest, index: number) {
  if (/private|fail|404/i.test(req.sourceUrl)) {
    setRun(runId, {
      state: 'FAILED',
      errorReason: 'download_failed: source returned 403 (video set to private)',
      finishedAt: Date.now(),
    });
    return;
  }
  const id = `lib-ingested-${runId.slice(0, 8)}`;
  const tail = req.sourceUrl.split('/').filter(Boolean).at(-1) ?? 'clip';
  const title = req.title ?? `New reference: ${tail.replace(/[-_]+/g, ' ')}`;
  const duration = 12 + ((index * 7 + tail.length) % 30);
  const item: LibraryItem = {
    id,
    title,
    description: 'Ingested from the Admin Centre in this demo session.',
    tags: req.tags.length ? req.tags : ['bakery', 'new'],
    durationSec: duration,
    aspectRatio: '9:16',
    sourcePlatform: req.sourcePlatform ?? platformOf(req.sourceUrl),
    sourceUrl: req.sourceUrl,
    categorySlug: req.category ?? 'business/local-business/bakeries',
    scene: SCENES[(index + tail.length) % SCENES.length] ?? 'sourdough',
    scenario: req.licenseScenario,
    licenseSource: req.licenseSource ?? null,
    ingestedAt: new Date().toISOString(),
    retiredAt: null,
    analysis: {
      hookPattern: 'bold text over first frame',
      structurePattern: 'hook-process-reveal-cta',
      ctaPattern: 'end card with a single action',
      paceTag: 'fast-cut',
      moodTag: 'upbeat',
      musicGenreTag: 'indie-pop',
      bpm: 116,
      energy: 'medium',
      hook: title.slice(0, 40),
    },
  };
  items.push(item);
  setRun(runId, { state: 'SUCCEEDED', finishedAt: Date.now(), libraryItemId: id });
}

/** Queue (or skip) each source; returns the real { queued, skipped } envelope. */
export function enqueueIngest(reqs: IngestRequest[]) {
  const queued: Array<{ sourceUrl: string; jobId: string; runId: string }> = [];
  const skipped: Array<{
    sourceUrl: string;
    runId: string;
    state: RunState;
    libraryItemId: string | null;
  }> = [];
  reqs.forEach((req, index) => {
    const runId = runIdFor(req.sourceUrl);
    const existing = runFor(req.sourceUrl);
    if (existing && existing.state !== 'FAILED') {
      skipped.push({
        sourceUrl: req.sourceUrl,
        runId,
        state: existing.state,
        libraryItemId: existing.libraryItemId,
      });
      return;
    }
    const attempts = (existing?.attempts ?? 0) + 1;
    const run: IngestRun = {
      runId,
      sourceUrl: req.sourceUrl,
      sourceRef: 'admin-centre',
      state: 'QUEUED',
      errorReason: null,
      attempts,
      updatedAt: Date.now(),
      finishedAt: null,
      libraryItemId: null,
    };
    if (existing) setRun(runId, run);
    else runs.push(run);
    queued.push({
      sourceUrl: req.sourceUrl,
      jobId: `ingest-library-video:${runId}${attempts > 1 ? `:${attempts}` : ''}`,
      runId,
    });
    window.setTimeout(() => setRun(runId, { state: 'RUNNING' }), 3_000 + index * 800);
    window.setTimeout(() => finish(runId, req, index), 11_000 + index * 1_500);
  });
  return { queued, skipped };
}
