import type { AuditRecord, AuditSink } from './audit-sink';
import { UpstreamServiceError } from './errors';
import { logger } from './logger';
import { studioModes } from './mode';

// Integration point 4 (Engagement handover 7.5, Studio spec 16.2). Fire-and-forget POST to
// PostMind's audit service. Never throws and never blocks the caller. Failed deliveries are
// retried in the background; after the last attempt the full entry is logged at error level
// so the log pipeline holds the record for manual replay.

export interface AuditEntry {
  actorUserId: string;
  organisationId: string;
  action: string; // e.g. 'studio.project.approve'
  resource: { type: string; id: string };
  metadata?: Record<string, unknown>;
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 5_000;

export interface AuditDeliveryDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function postOnce(url: string, token: string, body: string, fetchImpl: typeof fetch) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Token': token },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok)
    throw new UpstreamServiceError('Audit service rejected entry', { status: res.status });
}

/** Deliver one entry with retries. Resolves `true` on success, `false` when it gave up. */
export async function deliverAuditEntry(
  entry: AuditEntry,
  deps: AuditDeliveryDeps = {},
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const url = process.env.POSTMIND_AUDIT_URL;
  const token = process.env.POSTMIND_SERVICE_TOKEN;
  const payload = { ...entry, source: 'studio', timestamp: new Date().toISOString() };

  if (!url || !token) {
    logger.error({ audit: payload }, '[audit] POSTMIND_AUDIT_URL or service token not set');
    return false;
  }

  const body = JSON.stringify(payload);
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await postOnce(url, token, body, fetchImpl);
      return true;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
  logger.error(
    { audit: payload, err: lastError, attempts: MAX_ATTEMPTS },
    '[audit] delivery failed; entry recorded here for replay',
  );
  return false;
}

// Phase 18 §2.6: the sink is chosen once from STUDIO_AUDIT_SINK. Core mode (and any call with
// explicit delivery deps) keeps the pre-Phase-18 path above unchanged.
let sinkPromise: Promise<AuditSink | null> | undefined;

async function buildSink(): Promise<AuditSink | null> {
  const kind = studioModes().auditSink;
  if (kind === 'core') return null;
  const [{ prisma }, local] = await Promise.all([import('./prisma'), import('./audit-local')]);
  const localSink = local.createLocalAuditSink(prisma);
  return kind === 'both'
    ? local.createBothAuditSink(localSink, local.createCoreAuditSink())
    : localSink;
}

/** The configured sink; null = Core delivery (core mode). */
export function getAuditSink(): Promise<AuditSink | null> {
  sinkPromise ??= buildSink().catch((err: unknown) => {
    sinkPromise = undefined;
    throw err;
  });
  return sinkPromise;
}

/** Test hook: install a sink (null = Core delivery), or undefined to reset to env. */
export function setAuditSink(sink: AuditSink | null | undefined): void {
  sinkPromise = sink === undefined ? undefined : Promise.resolve(sink);
}

/** Record an audit entry. Returns immediately; delivery happens in the background. */
export function auditLog(entry: AuditEntry, deps?: AuditDeliveryDeps): void {
  if (deps) {
    void deliverAuditEntry(entry, deps).catch((err: unknown) => {
      logger.error({ err, audit: entry }, '[audit] unexpected delivery failure');
    });
    return;
  }
  void getAuditSink()
    .then((sink) => (sink ? sink.write(entry) : deliverAuditEntry(entry).then(() => undefined)))
    .catch((err: unknown) => {
      logger.error({ err, audit: entry }, '[audit] entry not stored; recorded here for replay');
    });
}

/**
 * Phase 18 §2.6: await the write (auth, billing, membership, consent, deletion events). Never
 * throws: when the sink fails, the full entry goes to the error log (the fallback record).
 */
export async function auditLogDurable(record: AuditRecord): Promise<void> {
  try {
    const sink = await getAuditSink();
    if (sink) {
      await sink.write(record);
      return;
    }
    const delivered = await deliverAuditEntry({
      actorUserId: record.actorUserId ?? 'system',
      organisationId: record.organisationId ?? 'none',
      action: record.action,
      resource: record.resource,
      metadata: record.metadata,
    });
    if (!delivered) throw new UpstreamServiceError('Audit entry was not delivered');
  } catch (err) {
    logger.error(
      { err, audit: record },
      '[audit] durable entry not stored; recorded here for replay',
    );
  }
}
