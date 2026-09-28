import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import type { DomainVerification, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import type { AssetStorage } from '../storage';
import { toPlanTier } from '../services/catalog';

// BACKLOG 13.11 — Addendum A6.7 / A11.2:
//   "Verification (Enterprise): a DNS TXT record … may be required to confirm ownership."
//   "If a scan runs and the user later reports they did not own the site, all scraped assets
//    are purged within 24h" and "the business's image library is rebuilt from stock + generated".
// The user publishes TXT `_postmind-studio.<domain>` = `pm-studio-verify=<token>`; a poll job
// (every 10 minutes) looks it up with node:dns until it matches or the request expires (7 days).
// A dispute records who said so and why, and a purge job deletes the business's SCRAPED images
// (rows and S3 objects) at once; the poll job re-runs any purge still pending, well inside 24 h.

export const RECORD_PREFIX = '_postmind-studio';
export const VALUE_PREFIX = 'pm-studio-verify=';
export const VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PURGE_DEADLINE_MS = 24 * 60 * 60 * 1000;
export const DOMAIN_POLL_PATTERN = '*/10 * * * *';
/** PENDING rows checked per poll run. */
export const MAX_CHECKS_PER_POLL = 500;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** A registrable host name: lower-case, ≥ 2 labels, no IP literal, ≤ 253 characters. */
export function normaliseDomain(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      throw new ValidationError('domain must be a host name such as example.co.uk');
    }
  }
  host = host.replace(/\.$/, '').replace(/^www\./, '');
  const labels = host.split('.');
  const valid =
    host.length <= 253 &&
    labels.length >= 2 &&
    labels.every((l) => LABEL.test(l)) &&
    !/^\d+$/.test(labels.at(-1) ?? '');
  if (!valid) throw new ValidationError('domain must be a host name such as example.co.uk');
  return host;
}

export const startDomainVerificationInput = z
  .object({ domain: z.string().min(1).max(300) })
  .strict();

export const disputeDomainInput = z
  .object({
    reason: z.string().trim().min(3).max(1_000),
    /** The user confirms they do NOT own or represent the site (A6.7 repudiation). */
    confirmNotOwner: z.literal(true, {
      error: 'confirmNotOwner must be true: confirm you do not own this website',
    }),
  })
  .strict();

/** A6.7 names DNS verification as an Enterprise feature; the tier comes from Core's context. */
export function requireEnterprise(tenant: TenantContext): void {
  if (toPlanTier(tenant.organisation.planTier) !== 'ENTERPRISE')
    throw new ForbiddenError('Domain verification is available on the Enterprise plan', {
      planTier: tenant.organisation.planTier ?? null,
    });
}

export function recordName(domain: string): string {
  return `${RECORD_PREFIX}.${domain}`;
}

export function present(row: DomainVerification) {
  return {
    id: row.id,
    businessId: row.businessId,
    domain: row.domain,
    record: recordName(row.domain),
    recordType: 'TXT',
    value: `${VALUE_PREFIX}${row.token}`,
    state: row.state,
    checkAttempts: row.checkAttempts,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    verifiedAt: row.verifiedAt,
    expiresAt: row.expiresAt,
    disputedAt: row.disputedAt,
    disputeReason: row.disputeReason,
    purgeDueAt: row.purgeDueAt,
    purgedAt: row.purgedAt,
    purgeSummary: row.purgeSummary,
    createdAt: row.createdAt,
  };
}

type Scope = { organisationId: string; businessId: string };

function latest(db: PrismaClient, scope: Scope) {
  return db.domainVerification.findFirst({ where: scope, orderBy: { createdAt: 'desc' } });
}

/** POST: a new PENDING request, or the current one when it is for the same domain. */
export async function startDomainVerification(
  deps: { db: PrismaClient; now: () => number },
  tenant: TenantContext,
  businessId: string,
  input: z.infer<typeof startDomainVerificationInput>,
): Promise<{ verification: DomainVerification; created: boolean }> {
  requireEnterprise(tenant);
  const domain = normaliseDomain(input.domain);
  const scope = { organisationId: tenant.organisationId, businessId };
  const current = await latest(deps.db, scope);
  if (
    current &&
    current.domain === domain &&
    (current.state === 'VERIFIED' ||
      (current.state === 'PENDING' && current.expiresAt.getTime() > deps.now()))
  )
    return { verification: current, created: false };
  const verification = await deps.db.domainVerification.create({
    data: {
      ...scope,
      domain,
      token: randomBytes(16).toString('hex'),
      requestedByUserId: tenant.userId,
      expiresAt: new Date(deps.now() + VERIFICATION_TTL_MS),
    },
  });
  return { verification, created: true };
}

export async function getDomainVerification(db: PrismaClient, scope: Scope) {
  const row = await latest(db, scope);
  if (!row) throw new NotFoundError('No domain verification for this business');
  return row;
}

/** Repudiation: the user says they do not own the site. Purge is queued by the caller. */
export async function disputeDomain(
  deps: { db: PrismaClient; now: () => number },
  tenant: TenantContext,
  businessId: string,
  input: z.infer<typeof disputeDomainInput>,
): Promise<DomainVerification> {
  const scope = { organisationId: tenant.organisationId, businessId };
  const now = new Date(deps.now());
  const dispute = {
    state: 'DISPUTED' as const,
    disputedAt: now,
    disputedByUserId: tenant.userId,
    disputeReason: input.reason,
    purgeDueAt: new Date(deps.now() + PURGE_DEADLINE_MS),
  };
  const current = await latest(deps.db, scope);
  if (current?.state === 'DISPUTED' || current?.state === 'PURGED')
    throw new ConflictError(`Ownership of this site was already disputed (${current.state})`);
  if (current) {
    return deps.db.domainVerification.update({ where: { id: current.id }, data: dispute });
  }
  // Any tier may repudiate a scan; without a verification request the scanned domain is used.
  const scan = await deps.db.websiteScan.findFirst({
    where: scope,
    orderBy: { startedAt: 'desc' },
    select: { url: true },
  });
  if (!scan) throw new NotFoundError('This business has no website scan to dispute');
  return deps.db.domainVerification.create({
    data: {
      ...scope,
      domain: new URL(scan.url).hostname,
      token: randomBytes(16).toString('hex'),
      requestedByUserId: tenant.userId,
      expiresAt: now,
      ...dispute,
    },
  });
}

// ------------------------------------------------------------------ DNS

export type TxtResolver = (hostname: string) => Promise<string[][]>;

export const systemTxtResolver: TxtResolver = (hostname) => resolveTxt(hostname);

const NOT_FOUND_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

/**
 * Looks up the TXT record (a TXT record may be split into several strings, which are joined —
 * nodejs.org/api/dns.html#dnspromisesresolvetxthostname). `found` = the expected value is there.
 */
export async function checkTxtRecord(
  resolver: TxtResolver,
  domain: string,
  token: string,
): Promise<{ found: boolean; error: string | null }> {
  const expected = `${VALUE_PREFIX}${token}`;
  try {
    const records = await resolver(recordName(domain));
    const values = records.map((chunks) => chunks.join('').trim());
    return {
      found: values.includes(expected),
      error: values.includes(expected) ? null : 'TXT record found, but not the expected value',
    };
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    if (NOT_FOUND_CODES.has(code)) return { found: false, error: 'No TXT record yet' };
    return { found: false, error: `DNS lookup failed (${code || (err as Error).message})` };
  }
}

/** One poll pass over PENDING rows: VERIFIED on a match, EXPIRED after the TTL. */
export async function pollPendingVerifications(
  deps: { db: PrismaClient; resolveTxt: TxtResolver; now: () => number },
  limit = MAX_CHECKS_PER_POLL,
): Promise<{ checked: number; verified: number; expired: number }> {
  const now = new Date(deps.now());
  const expired = await deps.db.domainVerification.updateMany({
    where: { state: 'PENDING', expiresAt: { lte: now } },
    data: { state: 'EXPIRED' },
  });
  const pending = await deps.db.domainVerification.findMany({
    where: { state: 'PENDING' },
    orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }],
    take: limit,
  });
  let verified = 0;
  for (const row of pending) {
    const result = await checkTxtRecord(deps.resolveTxt, row.domain, row.token);
    const moved = await deps.db.domainVerification.updateMany({
      where: { id: row.id, state: 'PENDING' },
      data: {
        checkAttempts: { increment: 1 },
        lastCheckedAt: now,
        lastError: result.error,
        ...(result.found && { state: 'VERIFIED', verifiedAt: now }),
      },
    });
    if (result.found && moved.count === 1) verified += 1;
  }
  return { checked: pending.length, verified, expired: expired.count };
}

/** DISPUTED rows whose purge has not completed (re-run by the poll job). */
export function pendingPurges(db: PrismaClient) {
  return db.domainVerification.findMany({
    where: { state: 'DISPUTED', purgedAt: null },
    select: { id: true, organisationId: true, businessId: true },
    take: 100,
  });
}

/**
 * A6.7 / A11.2 purge: every SCRAPED image of the business (S3 object, then row), and any scan
 * still in progress is stopped. Stock and generated images stay. Idempotent.
 */
export async function purgeDisputedDomain(
  deps: { db: PrismaClient; storage: AssetStorage; now: () => number },
  verificationId: string,
): Promise<{ imagesDeleted: number; objectsDeleted: number; scansStopped: number } | null> {
  const row = await deps.db.domainVerification.findUnique({ where: { id: verificationId } });
  if (!row || row.state !== 'DISPUTED') return null;
  const scope = { organisationId: row.organisationId, businessId: row.businessId };
  const scansStopped = await deps.db.websiteScan.updateMany({
    where: { ...scope, state: { in: ['QUEUED', 'RUNNING'] } },
    data: {
      state: 'FAILED',
      errorReason: 'ownership_disputed: Stopped: website ownership was disputed',
      completedAt: new Date(deps.now()),
    },
  });
  const images = await deps.db.imageLibraryItem.findMany({
    where: { ...scope, source: 'SCRAPED' },
    select: { id: true, s3Bucket: true, s3Key: true },
  });
  let objectsDeleted = 0;
  for (const image of images) {
    if (image.s3Bucket && image.s3Key) {
      await deps.storage.delete(image.s3Bucket, image.s3Key);
      objectsDeleted += 1;
    }
  }
  const deleted = await deps.db.imageLibraryItem.deleteMany({
    where: { id: { in: images.map((i) => i.id) } },
  });
  const summary = {
    imagesDeleted: deleted.count,
    objectsDeleted,
    scansStopped: scansStopped.count,
  };
  await deps.db.domainVerification.update({
    where: { id: row.id },
    data: { state: 'PURGED', purgedAt: new Date(deps.now()), purgeSummary: summary },
  });
  return summary;
}
