// Phase 13 track A2 demo handlers: free-text library search (13.8), calendar reschedule (13.9),
// scan schedule (13.10), DNS domain verification + ownership dispute (13.11) and the admin
// "Resubmit failures" action (13.15). Shapes match src/lib/studio/services/library.ts
// searchLibraryVideos, services/publication-reschedule.ts, scan/schedule.ts,
// scan/domain-verification.ts present() and library/ingest-resubmit.ts.
import type { Publication } from '@/lib/client/types';
import { DEMO_BUSINESS_ID } from '../ids';
import { DemoHttpError, route } from '../registry';
import { isRelevant } from '@/lib/studio/library/relevance';
import { present } from './library';
import { enqueueIngest, ingestRuns } from './library-store';
import { getPublication, updatePublication } from './publications-store';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const bad = (message: string) => new DemoHttpError(400, 'validation_error', message);

// ------------------------------------------------------------------ 13.8 library search

function terms(q: string): string[] {
  return [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 10);
}

route('POST', '/library/search', async ({ body }) => {
  const input = (body ?? {}) as {
    q?: unknown;
    categorySlug?: unknown;
    limit?: unknown;
    cursor?: unknown;
  };
  const q = typeof input.q === 'string' ? input.q.trim() : '';
  if (!q || q.length > 200) throw bad('Request body failed validation');
  const limit = typeof input.limit === 'number' ? Math.min(50, Math.max(1, input.limit)) : 24;
  const offset =
    typeof input.cursor === 'string' && /^\d+$/.test(input.cursor) ? Number(input.cursor) : 0;
  const category = typeof input.categorySlug === 'string' ? input.categorySlug : '';
  const words = terms(q);
  const { libraryItems } = await import('./library-store');
  const ranked = libraryItems()
    .filter((v) => !category || v.categorySlug.startsWith(category))
    .map((v) => {
      const text = [v.title, v.description ?? '', v.analysis.moodTag, v.analysis.hookPattern]
        .join(' ')
        .toLowerCase();
      const hits = words.filter((w) => text.includes(w)).length;
      const tagHits = words.filter((w) => v.tags.includes(w)).length;
      // A stand-in for embedding similarity: word overlap on the analysed description. No overlap
      // is a weak (unrelated) similarity, like a real embedding of an unrelated text.
      const similarity =
        hits === 0 ? 0.12 : Math.round(Math.min(0.94, 0.42 + hits * 0.11) * 1000) / 1000;
      const title = words.some((w) => v.title.toLowerCase().includes(w)) ? 0.1 : 0;
      const boost = title + Math.min(0.15, tagHits * 0.05);
      const score = Math.round((similarity + boost) * 1e4) / 1e4;
      return { v, similarity, score, boost };
    })
    // The same relevance floor as live (library/relevance.ts).
    .filter(({ similarity, boost }) => isRelevant(similarity, boost))
    .sort((a, b) => b.score - a.score || a.v.id.localeCompare(b.v.id));
  const page = ranked.slice(offset, offset + limit);
  const next = offset + limit;
  return {
    data: page.map(({ v, similarity, score }) => ({ ...present(v), similarity, score })),
    nextCursor: ranked.length > next && next <= 480 ? String(next) : null,
  };
});

// ------------------------------------------------------------------ 13.9 reschedule

route('PATCH', '/publications/:id', ({ params, body }) => {
  const p = getPublication(params.id ?? '');
  if (!p) throw new DemoHttpError(404, 'not_found', 'Publication not found');
  const raw = (body as { scheduledFor?: unknown } | undefined)?.scheduledFor;
  const at = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  if (Number.isNaN(at)) throw bad('Request body failed validation');
  const lead = at - Date.now();
  if (lead < MIN || lead > 180 * DAY)
    throw bad('scheduledFor must be between 1 minute and 180 days from now');
  if (p.state !== 'SCHEDULED' || !p.scheduledFor)
    throw new DemoHttpError(
      409,
      'conflict',
      `Only scheduled publications can be moved (this one is ${p.state})`,
    );
  const updated = updatePublication(p.id, {
    scheduledFor: new Date(at).toISOString(),
  }) as Publication;
  const { project: _project, ...publication } = updated;
  void _project;
  return { publication };
});

// ------------------------------------------------------------------ 13.10 scan schedule

const LOADED_AT = Date.now();

function nextTick(from: number, hour: number, minute: number, weekday?: number): string {
  const d = new Date(from);
  const offset = weekday === undefined ? 0 : (weekday - d.getUTCDay() + 7) % 7;
  let tick = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offset, hour, minute);
  if (tick < from) tick += weekday === undefined ? DAY : 7 * DAY;
  return new Date(tick).toISOString();
}

route('GET', '/businesses/:id/scans/schedule', ({ params }) => {
  if (params.id !== DEMO_BUSINESS_ID)
    return {
      nextScanAt: null,
      nextStockRefreshAt: null,
      lastSkippedUnchangedAt: null,
      lastScanAt: null,
      intervalDays: 30,
    };
  // Seeded history: last successful scan 21 days ago, so the next rescan is due in 9 days.
  const lastScan = LOADED_AT - 21 * DAY;
  return {
    nextScanAt: nextTick(lastScan + 30 * DAY, 3, 30),
    nextStockRefreshAt: nextTick(Date.now(), 4, 0, 1),
    lastSkippedUnchangedAt: null,
    lastScanAt: new Date(lastScan).toISOString(),
    intervalDays: 30,
  };
});

// ------------------------------------------------------------------ 13.11 domain verification

type DomainState = 'PENDING' | 'VERIFIED' | 'EXPIRED' | 'DISPUTED' | 'PURGED';
interface Verification {
  id: string;
  businessId: string;
  domain: string;
  token: string;
  state: DomainState;
  checkAttempts: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  verifiedAt: string | null;
  expiresAt: string;
  disputedAt: string | null;
  disputeReason: string | null;
  purgeDueAt: string | null;
  purgedAt: string | null;
  purgeSummary: Record<string, number> | null;
  createdAt: string;
  /** Demo only: when the simulated DNS check finds the record. */
  verifyAt: number;
}

const verifications: Verification[] = [];
const VERIFY_AFTER_MS = 25_000;

function tick(v: Verification): Verification {
  const now = Date.now();
  if (v.state === 'PENDING') {
    const found = now >= v.verifyAt;
    Object.assign(v, {
      checkAttempts: Math.max(1, Math.floor((now - Date.parse(v.createdAt)) / 10_000)),
      lastCheckedAt: new Date(now).toISOString(),
      lastError: found ? null : 'No TXT record yet',
      ...(found && { state: 'VERIFIED', verifiedAt: new Date(now).toISOString() }),
    });
  }
  if (v.state === 'DISPUTED' && v.disputedAt && now - Date.parse(v.disputedAt) > 8_000)
    Object.assign(v, {
      state: 'PURGED',
      purgedAt: new Date(now).toISOString(),
      purgeSummary: { imagesDeleted: 12, objectsDeleted: 12, scansStopped: 0 },
    });
  return v;
}

function presentVerification(v: Verification) {
  const { token, verifyAt: _verifyAt, ...rest } = tick(v);
  void _verifyAt;
  return {
    ...rest,
    record: `_postmind-studio.${v.domain}`,
    recordType: 'TXT',
    value: `pm-studio-verify=${token}`,
  };
}

const latest = (businessId: string) =>
  verifications.filter((v) => v.businessId === businessId).at(-1);

function token(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

route('GET', '/businesses/:id/domain-verification', ({ params }) => {
  const v = latest(params.id ?? '');
  if (!v) throw new DemoHttpError(404, 'not_found', 'No domain verification for this business');
  return { verification: presentVerification(v) };
});

route('POST', '/businesses/:id/domain-verification', ({ params, body }) => {
  const raw = (body as { domain?: unknown } | undefined)?.domain;
  const domain =
    typeof raw === 'string'
      ? raw
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/\/.*$/, '')
          .replace(/^www\./, '')
      : '';
  if (!/^([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(domain))
    throw bad('domain must be a host name such as example.co.uk');
  const businessId = params.id ?? '';
  const current = latest(businessId);
  if (
    current &&
    current.domain === domain &&
    (current.state === 'PENDING' || current.state === 'VERIFIED')
  )
    return { status: 200, body: { verification: presentVerification(current) } };
  const now = Date.now();
  const v: Verification = {
    id: `dv-${verifications.length + 1}`,
    businessId,
    domain,
    token: token(),
    state: 'PENDING',
    checkAttempts: 0,
    lastCheckedAt: null,
    lastError: null,
    verifiedAt: null,
    expiresAt: new Date(now + 7 * DAY).toISOString(),
    disputedAt: null,
    disputeReason: null,
    purgeDueAt: null,
    purgedAt: null,
    purgeSummary: null,
    createdAt: new Date(now).toISOString(),
    verifyAt: now + VERIFY_AFTER_MS,
  };
  verifications.push(v);
  return { status: 201, body: { verification: presentVerification(v) } };
});

route('POST', '/businesses/:id/domain-verification/dispute', ({ params, body }) => {
  const input = (body ?? {}) as { reason?: unknown; confirmNotOwner?: unknown };
  if (
    typeof input.reason !== 'string' ||
    input.reason.trim().length < 3 ||
    input.confirmNotOwner !== true
  )
    throw bad('Request body failed validation');
  const businessId = params.id ?? '';
  const now = Date.now();
  const current = latest(businessId);
  if (current && (current.state === 'DISPUTED' || current.state === 'PURGED'))
    throw new DemoHttpError(
      409,
      'conflict',
      `Ownership of this site was already disputed (${current.state})`,
    );
  const dispute = {
    state: 'DISPUTED' as const,
    disputedAt: new Date(now).toISOString(),
    disputeReason: input.reason.trim(),
    purgeDueAt: new Date(now + DAY).toISOString(),
  };
  const v: Verification = current
    ? Object.assign(current, dispute)
    : {
        id: `dv-${verifications.length + 1}`,
        businessId,
        domain: 'leedssourdough.co.uk',
        token: token(),
        checkAttempts: 0,
        lastCheckedAt: null,
        lastError: null,
        verifiedAt: null,
        expiresAt: new Date(now).toISOString(),
        purgedAt: null,
        purgeSummary: null,
        createdAt: new Date(now).toISOString(),
        verifyAt: Number.POSITIVE_INFINITY,
        ...dispute,
      };
  if (!current) verifications.push(v);
  return { status: 202, body: { verification: presentVerification(v) } };
});

// ------------------------------------------------------------------ 13.15 resubmit failures

route('POST', '/admin/library/ingest/resubmit', ({ body }) => {
  const input = (body ?? {}) as { runIds?: unknown; failedOnly?: unknown };
  const wanted = Array.isArray(input.runIds) ? new Set(input.runIds as string[]) : null;
  const failed = ingestRuns().filter(
    (r) => r.state === 'FAILED' && (!wanted || wanted.has(r.runId)),
  );
  const result = enqueueIngest(
    failed.map((r) => ({ sourceUrl: r.sourceUrl, licenseScenario: 'NOT_REQUIRED', tags: [] })),
  );
  return {
    status: 202,
    body: {
      queued: result.queued.length,
      skipped: result.skipped.length,
      runs: [
        ...result.queued.map((q) => ({ runId: q.runId, action: 'queued', jobId: q.jobId })),
        ...result.skipped.map((s) => ({
          runId: s.runId,
          action: 'skipped',
          reason: `already ${s.state}`,
        })),
      ],
    },
  };
});
