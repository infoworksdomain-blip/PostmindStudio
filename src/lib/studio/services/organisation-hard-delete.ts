import type { OrganisationPurge, Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AuditEntry } from '../../audit';
import { ConfigurationError, ValidationError } from '../../errors';
import type { AssetStorage } from '../storage';
import { organisationIdParam } from './org-policy';
import {
  bucketsFor,
  countKeysOutsidePrefix,
  countPrefix,
  deletePrefix,
  orgPrefix,
  type PrefixCount,
} from './purge-storage';
import {
  anonymiseRows,
  ANONYMISE_STEPS,
  countRows,
  deleteBatch,
  PURGE_TABLE_STEPS,
} from './purge-tables';

// BACKLOG 14.1 — hard deletion after the purge grace (spec 8.x internal API "soft-deletes all
// Studio data with 30-day grace"; Engagement handover 6.5 "or hard-deletes after 30-day grace",
// 14.13). A daily job (hard-delete-purged-orgs, scripts/worker.ts) takes every
// organisation_purges row whose graceUntil has passed and:
//   1. deletes every object under orgs/<organisationId>/ in each configured bucket and each
//      bucket the organisation's rows point at (S3 first: the rows name the buckets);
//   2. deletes the organisation's rows from every studio table in FK-safe order, in batches
//      (purge-tables.ts);
//   3. clears the personal fields of the rows deliberately kept (takedown_requests, the legal /
//      transparency record: ANONYMISE_STEPS), counted as "<table>:anonymised";
//   4. keeps the organisation_purges row as the tombstone: state hard_deleted, hardDeletedAt,
//      and hardDeleteSummary (rows per table, objects per bucket/prefix), and writes the audit
//      entry studio.organisation.hard_delete. The audit trail itself is never deleted.
// Idempotent and resumable: a crash leaves state hard_deleting and the next run starts again;
// already-deleted rows and objects are simply not found. Counts accumulate across attempts.
// GET /api/studio/admin/organisations/:id/purge-plan is the staff dry run (planHardDelete).
// Undo during the grace (organisation restored): set the row's state to 'cancelled' (runbook
// platform-account-revocation.md); cancelled purges are never hard-deleted.

export const DEFAULT_PURGE_GRACE_DAYS = 30;
export const MAX_PURGE_GRACE_DAYS = 365;
export const HARD_DELETE_SCHEDULE = '30 1 * * *'; // 01:30 UTC daily
export const HARD_DELETE_BATCH = 500;
export const HARD_DELETE_ACTOR = 'system:organisation-purge';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Purge states the hard delete acts on ('cancelled' and 'hard_deleted' are final). */
const DUE_STATES: readonly string[] = ['soft_deleted', 'hard_deleting'];

/** STUDIO_PURGE_GRACE_DAYS (Engagement handover 14.13: 30 days). */
export function purgeGraceDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env.STUDIO_PURGE_GRACE_DAYS?.trim();
  if (!raw) return DEFAULT_PURGE_GRACE_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > MAX_PURGE_GRACE_DAYS) {
    throw new ConfigurationError(
      `STUDIO_PURGE_GRACE_DAYS must be a whole number of days from 1 to ${MAX_PURGE_GRACE_DAYS}`,
    );
  }
  return days;
}

export const graceUntilFrom = (requestedAt: Date, days: number) =>
  new Date(requestedAt.getTime() + days * DAY_MS);

export interface HardDeleteSummary {
  tables: Record<string, number>;
  storage: Record<string, { objects: number; bytes: number }>;
  /** Row-referenced keys outside orgs/<id>/: never deleted (shared objects), reported only. */
  keysOutsidePrefix: number;
}

export interface PurgePlan {
  organisationId: string;
  purge: {
    state: string;
    requestedAt: string;
    graceUntil: string;
    /** graceUntil has passed: the next daily run hard-deletes. */
    due: boolean;
    hardDeletedAt: string | null;
    hardDeleteAttempts: number;
    hardDeleteError: string | null;
    summary: HardDeleteSummary | null;
  } | null;
  tables: { table: string; rows: number }[];
  storage: PrefixCount[];
  keysOutsidePrefix: number;
  totals: { rows: number; objects: number; bytes: number };
}

interface PlanDeps {
  db: PrismaClient;
  storage: AssetStorage;
  now: () => number;
  buckets: string[];
}

function parseOrg(organisationId: string): string {
  const parsed = organisationIdParam.safeParse(organisationId);
  if (!parsed.success) throw new ValidationError('Invalid organisation id');
  return parsed.data;
}

function presentPurge(purge: OrganisationPurge | null, now: number): PurgePlan['purge'] {
  if (!purge) return null;
  return {
    state: purge.state,
    requestedAt: purge.requestedAt.toISOString(),
    graceUntil: purge.graceUntil.toISOString(),
    due: DUE_STATES.includes(purge.state) && purge.graceUntil.getTime() <= now,
    hardDeletedAt: purge.hardDeletedAt?.toISOString() ?? null,
    hardDeleteAttempts: purge.hardDeleteAttempts,
    hardDeleteError: purge.hardDeleteError,
    summary: (purge.hardDeleteSummary as HardDeleteSummary | null) ?? null,
  };
}

/** Dry run: what a hard delete would remove now (rows per table, objects per bucket/prefix). */
export async function planHardDelete(deps: PlanDeps, organisationId: string): Promise<PurgePlan> {
  const org = parseOrg(organisationId);
  const prefix = orgPrefix(org);
  const purge = await deps.db.organisationPurge.findUnique({ where: { organisationId: org } });
  const tables: PurgePlan['tables'] = [];
  for (const step of PURGE_TABLE_STEPS) {
    tables.push({ table: step.table, rows: await countRows(deps.db, step, org) });
  }
  const storage: PrefixCount[] = [];
  for (const bucket of await bucketsFor(deps.db, org, deps.buckets)) {
    storage.push(await countPrefix(deps.storage, bucket, prefix));
  }
  return {
    organisationId: org,
    purge: presentPurge(purge, deps.now()),
    tables,
    storage,
    keysOutsidePrefix: await countKeysOutsidePrefix(deps.db, org),
    totals: {
      rows: tables.reduce((n, r) => n + r.rows, 0),
      objects: storage.reduce((n, s) => n + s.objects, 0),
      bytes: storage.reduce((n, s) => n + s.bytes, 0),
    },
  };
}

export interface HardDeleteDeps extends PlanDeps {
  logger: Logger;
  audit: (entry: AuditEntry) => void;
  batchSize?: number;
}

function mergeSummary(previous: unknown, next: HardDeleteSummary): HardDeleteSummary {
  const prev = (previous as HardDeleteSummary | null) ?? {
    tables: {},
    storage: {},
    keysOutsidePrefix: 0,
  };
  const tables = { ...prev.tables };
  for (const [k, n] of Object.entries(next.tables)) tables[k] = (tables[k] ?? 0) + n;
  const storage = { ...prev.storage };
  for (const [k, v] of Object.entries(next.storage)) {
    const was = storage[k] ?? { objects: 0, bytes: 0 };
    storage[k] = { objects: was.objects + v.objects, bytes: was.bytes + v.bytes };
  }
  return {
    tables,
    storage,
    keysOutsidePrefix: Math.max(prev.keysOutsidePrefix, next.keysOutsidePrefix),
  };
}

/** Hard-deletes one organisation whose grace period has passed. Returns the tombstone summary. */
export async function hardDeleteOrganisation(
  deps: HardDeleteDeps,
  organisationId: string,
): Promise<{
  status: 'deleted' | 'not_due' | 'not_purged' | 'already_deleted' | 'cancelled';
  summary?: HardDeleteSummary;
}> {
  const org = parseOrg(organisationId);
  const purge = await deps.db.organisationPurge.findUnique({ where: { organisationId: org } });
  if (!purge) return { status: 'not_purged' };
  if (purge.state === 'hard_deleted') return { status: 'already_deleted' };
  if (!DUE_STATES.includes(purge.state)) return { status: 'cancelled' };
  const now = new Date(deps.now());
  if (purge.graceUntil.getTime() > now.getTime()) return { status: 'not_due' };

  await deps.db.organisationPurge.update({
    where: { organisationId: org },
    data: {
      state: 'hard_deleting',
      hardDeleteStartedAt: purge.hardDeleteStartedAt ?? now,
      hardDeleteAttempts: { increment: 1 },
      hardDeleteError: null,
    },
  });
  // Progress is saved after every step, so the tombstone counts survive a crash mid-way.
  let summary = mergeSummary(purge.hardDeleteSummary, {
    tables: {},
    storage: {},
    keysOutsidePrefix: await countKeysOutsidePrefix(deps.db, org),
  });
  const save = async (data: Prisma.OrganisationPurgeUpdateInput = {}) => {
    await deps.db.organisationPurge.update({
      where: { organisationId: org },
      data: { ...data, hardDeleteSummary: summary as unknown as Prisma.InputJsonValue },
    });
  };
  try {
    const prefix = orgPrefix(org);
    for (const bucket of await bucketsFor(deps.db, org, deps.buckets)) {
      const removed = await deletePrefix(deps.storage, bucket, prefix);
      summary = mergeSummary(summary, {
        tables: {},
        storage: { [`${bucket}/${prefix}`]: removed },
        keysOutsidePrefix: 0,
      });
      await save();
    }
    const limit = deps.batchSize ?? HARD_DELETE_BATCH;
    for (const step of PURGE_TABLE_STEPS) {
      let rows = 0;
      for (;;) {
        const n = await deleteBatch(deps.db, step, org, limit);
        rows += n;
        if (n < limit) break;
      }
      summary = mergeSummary(summary, {
        tables: { [step.table]: rows },
        storage: {},
        keysOutsidePrefix: 0,
      });
      await save();
    }
    for (const step of ANONYMISE_STEPS) {
      const rows = await anonymiseRows(deps.db, step, org);
      summary = mergeSummary(summary, {
        tables: { [`${step.table}:anonymised`]: rows },
        storage: {},
        keysOutsidePrefix: 0,
      });
      await save();
    }
    await save({ state: 'hard_deleted', hardDeletedAt: new Date(deps.now()) });
    deps.audit({
      actorUserId: HARD_DELETE_ACTOR,
      organisationId: org,
      action: 'studio.organisation.hard_delete',
      resource: { type: 'organisation', id: org },
      metadata: { ...summary, requestedAt: purge.requestedAt.toISOString() },
    });
    return { status: 'deleted', summary };
  } catch (err) {
    await deps.db.organisationPurge.update({
      where: { organisationId: org },
      data: { hardDeleteError: (err as Error).message.slice(0, 1_000) },
    });
    throw err;
  }
}

/** The daily sweep: every purge past its grace that is not hard-deleted yet. */
export async function hardDeleteDuePurges(deps: HardDeleteDeps): Promise<{
  due: number;
  deleted: string[];
  failed: { organisationId: string; error: string }[];
}> {
  const due = await deps.db.organisationPurge.findMany({
    where: { state: { in: [...DUE_STATES] }, graceUntil: { lte: new Date(deps.now()) } },
    orderBy: { graceUntil: 'asc' },
    select: { organisationId: true },
  });
  const deleted: string[] = [];
  const failed: { organisationId: string; error: string }[] = [];
  for (const { organisationId } of due) {
    try {
      const out = await hardDeleteOrganisation(deps, organisationId);
      if (out.status === 'deleted') deleted.push(organisationId);
    } catch (err) {
      deps.logger.error({ err, organisationId }, 'organisation hard delete failed');
      failed.push({ organisationId, error: (err as Error).message });
    }
  }
  return { due: due.length, deleted, failed };
}
