import type { Prisma, PrismaClient } from '@prisma/client';
import type { FallbackNotice } from './fallback-notice';
import { projectMetadata } from './project-state';

// BACKLOG 23.6 — the run state of asynchronous renders, kept in project.metadata (one key per
// script, written atomically in SQL like recordRunRender, always for the current run only):
//
//   pendingRenders   { <scriptId>: PendingRender }   a render submitted and not yet recorded
//   mastering        { <scriptId>: MasteringReport }  13.26 report per recorded render
//   renderPollClaim  { token, until }                 the poll-render job working on the run now
//   renderPollNext   "<job id>"                       the delayed poll a render callback promotes
//   composeRetries   n                                renders re-submitted after failures (≤ 5)
//
// A render is pending from its submit until poll-render records it (render row + renders pointer
// + pending entry removed, in one transaction) or gives it up (entry removed, compose retried).

export const PENDING_RENDERS_KEY = 'pendingRenders';
export const MASTERING_KEY = 'mastering';
export const RENDER_POLL_CLAIM_KEY = 'renderPollClaim';
export const RENDER_POLL_NEXT_KEY = 'renderPollNext';
export const COMPOSE_RETRIES_KEY = 'composeRetries';

/** One submitted render of one script (output variant), as stored in metadata.pendingRenders. */
export interface PendingRender {
  providerId: string;
  /** studio.provider_jobs.id: the tracked job (its estimate is reserved until it is polled). */
  providerJobRowId: string;
  providerJobId: string;
  /** ISO: submitted, and when the render is given up (the provider timeout, as before 23.6). */
  submittedAt: string;
  giveUpAt: string;
  targetPlatform: string;
  aspectRatio: string;
  /** 15.B2 timeline summary + 15.B6 edit hash, stored on the render row when it is recorded. */
  composition: Prisma.JsonValue;
  /** 20.29 in-flight slot, given back when the render ends. */
  lease?: { leaseId: string; byoc: boolean };
  /** 15.B9: the composer was a fallback provider. */
  fallback?: FallbackNotice | null;
  /** Queue priority of the run (a callback wake re-enqueues with it). */
  planTier: string;
  batch?: boolean;
}

type RawClient = Pick<PrismaClient, '$executeRaw'>;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** metadata.pendingRenders of a project (entries without the required ids are ignored). */
export function pendingRendersOf(metadata: Prisma.JsonValue | null): Record<string, PendingRender> {
  const raw = projectMetadata(metadata)[PENDING_RENDERS_KEY];
  if (!isObject(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, PendingRender] =>
        isObject(entry[1]) &&
        typeof entry[1].providerJobRowId === 'string' &&
        typeof entry[1].providerId === 'string',
    ),
  );
}

export function renderPointersOf(metadata: Prisma.JsonValue | null): Record<string, string> {
  const raw = projectMetadata(metadata).renders;
  return isObject(raw)
    ? Object.fromEntries(
        Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'),
      )
    : {};
}

export function composeRetriesOf(metadata: Prisma.JsonValue | null): number {
  const n = projectMetadata(metadata)[COMPOSE_RETRIES_KEY];
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
}

/** Set metadata[key][entryKey] = value for the run, atomically. False when the run moved on. */
export async function setRunEntry(
  db: RawClient,
  input: { projectId: string; runId: string; key: string; entryKey: string; value: unknown },
): Promise<boolean> {
  const count = await db.$executeRaw`
    UPDATE "studio"."video_projects"
    SET "metadata" = jsonb_set(
          COALESCE("metadata", '{}'::jsonb),
          ARRAY[${input.key}]::text[],
          (CASE WHEN jsonb_typeof("metadata"->${input.key}) = 'object'
                THEN "metadata"->${input.key} ELSE '{}'::jsonb END)
            || jsonb_build_object(${input.entryKey}::text, ${JSON.stringify(input.value)}::jsonb)
        ),
        "updatedAt" = now()
    WHERE "id" = ${input.projectId} AND "metadata"->>'runId' = ${input.runId}`;
  return count === 1;
}

/** Remove metadata[key][entryKey] for the run, atomically. */
export async function deleteRunEntry(
  db: RawClient,
  input: { projectId: string; runId: string; key: string; entryKey: string },
): Promise<boolean> {
  const count = await db.$executeRaw`
    UPDATE "studio"."video_projects"
    SET "metadata" = jsonb_set(
          COALESCE("metadata", '{}'::jsonb),
          ARRAY[${input.key}]::text[],
          (CASE WHEN jsonb_typeof("metadata"->${input.key}) = 'object'
                THEN "metadata"->${input.key} ELSE '{}'::jsonb END) - ${input.entryKey}::text
        ),
        "updatedAt" = now()
    WHERE "id" = ${input.projectId} AND "metadata"->>'runId' = ${input.runId}`;
  return count === 1;
}

/** Append items to the list metadata[key] for the run, atomically (15.B9 fallback notices). */
export async function appendRunList(
  db: RawClient,
  input: { projectId: string; runId: string; key: string; items: unknown[] },
): Promise<boolean> {
  if (input.items.length === 0) return true;
  const count = await db.$executeRaw`
    UPDATE "studio"."video_projects"
    SET "metadata" = jsonb_set(
          COALESCE("metadata", '{}'::jsonb),
          ARRAY[${input.key}]::text[],
          (CASE WHEN jsonb_typeof("metadata"->${input.key}) = 'array'
                THEN "metadata"->${input.key} ELSE '[]'::jsonb END)
            || ${JSON.stringify(input.items)}::jsonb
        ),
        "updatedAt" = now()
    WHERE "id" = ${input.projectId} AND "metadata"->>'runId' = ${input.runId}`;
  return count === 1;
}

/**
 * Take the run's poll claim (exactly one poll-render job works on a run at a time, so a render is
 * settled and recorded once however many polls or callbacks arrive). Granted when nobody holds
 * it, the holder's lease ran out, or `token` already holds it (a retry of the same job). Returns
 * the project's metadata as of the claim, or null when the claim is held or the run moved on.
 */
export async function claimRenderPoll(
  db: Pick<PrismaClient, '$queryRaw'>,
  input: { projectId: string; runId: string; token: string; now: number; leaseMs: number },
): Promise<Prisma.JsonValue | null> {
  const rows = await db.$queryRaw<Array<{ metadata: Prisma.JsonValue }>>`
    UPDATE "studio"."video_projects"
    SET "metadata" = jsonb_set(
          COALESCE("metadata", '{}'::jsonb),
          '{renderPollClaim}',
          jsonb_build_object('token', ${input.token}::text, 'until', ${input.now + input.leaseMs}::bigint)
        ),
        "updatedAt" = now()
    WHERE "id" = ${input.projectId}
      AND "metadata"->>'runId' = ${input.runId}
      AND (
        "metadata"->'renderPollClaim' IS NULL
        OR "metadata"->'renderPollClaim'->>'token' = ${input.token}
        OR ("metadata"->'renderPollClaim'->>'until')::bigint < ${input.now}::bigint
      )
    RETURNING "metadata"`;
  return rows[0]?.metadata ?? null;
}

/** Give the poll claim back (only the holder's token can). */
export async function releaseRenderPoll(
  db: RawClient,
  input: { projectId: string; token: string },
): Promise<void> {
  await db.$executeRaw`
    UPDATE "studio"."video_projects"
    SET "metadata" = "metadata" - 'renderPollClaim'
    WHERE "id" = ${input.projectId}
      AND "metadata"->'renderPollClaim'->>'token' = ${input.token}`;
}
