import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type SystemFlag } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors';
import { FLAG_OFF, FLAG_ON, flagKeys, PROVIDER_IDS } from '../system-flags';
import { PLATFORMS } from './catalog';

// Spec 12 / 16.4 (Admin Centre "Kill switch" + "Workspace freeze"): read and flip the four
// kill-switch levels stored in system_flags, plus the per-platform publishing level (Phase 12).
// Workers read flags with a 30 s cache, so a change takes effect within 30 s everywhere (the admin
// API's own cache is invalidated immediately).

export const setKillSwitchInput = z
  .object({
    level: z.enum(['global', 'workspace', 'project', 'provider', 'platform']),
    /** organisationId (workspace), projectId (project), providerId (provider) or platform. */
    target: z.string().trim().min(1).max(128).optional(),
    enabled: z.boolean(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine((v) => v.level === 'global' || Boolean(v.target), {
    message: 'target is required for workspace, project, provider and platform levels',
  })
  .refine(
    (v) => v.level !== 'provider' || (PROVIDER_IDS as readonly string[]).includes(v.target ?? ''),
    {
      message: 'Unknown providerId',
    },
  )
  .refine(
    (v) => v.level !== 'platform' || (PLATFORMS as readonly string[]).includes(v.target ?? ''),
    { message: 'Unknown platform' },
  );

export function flagKeyFor(input: z.infer<typeof setKillSwitchInput>): string {
  switch (input.level) {
    case 'global':
      return flagKeys.global();
    case 'workspace':
      return flagKeys.workspace(input.target ?? '');
    case 'project':
      return flagKeys.project(input.target ?? '');
    case 'provider':
      return flagKeys.provider(input.target ?? '');
    case 'platform':
      return flagKeys.platform(input.target ?? '');
  }
}

export async function setKillSwitch(db: PrismaClient, input: z.infer<typeof setKillSwitchInput>) {
  const key = flagKeyFor(input);
  const value = input.enabled ? FLAG_ON : FLAG_OFF;
  return db.systemFlag.upsert({ where: { key }, create: { key, value }, update: { value } });
}

const on = (value: string) => value === FLAG_ON;

export async function killSwitchState(db: PrismaClient, now: number = Date.now()) {
  const flags = await db.systemFlag.findMany({ where: { key: { startsWith: 'studio.' } } });
  const request = parsePending(flags.find((f) => f.key === PENDING_GLOBAL_KILL_KEY)?.value);
  const pick = (prefix: string) =>
    flags
      .filter((f) => f.key.startsWith(prefix) && on(f.value))
      .map((f) => ({ id: f.key.slice(prefix.length), since: f.updatedAt }));
  const global = flags.find((f) => f.key === flagKeys.global());
  return {
    global: { enabled: global ? on(global.value) : false, since: global?.updatedAt ?? null },
    frozenWorkspaces: pick(flagKeys.workspace('')),
    killedProjects: pick(flagKeys.project('')),
    disabledProviders: pick(flagKeys.provider('')),
    disabledPlatforms: pick(flagKeys.platform('')),
    propagationSec: 30,
    /** 15.D6: a global kill waiting for a second staff member (null when none or expired). */
    pendingGlobal: request && !isExpired(request, now) ? request : null,
    /** 15.D6: break-glass STUDIO_KILL_SWITCH_SINGLE_APPROVER=true (one person engages). */
    singleApprover: singleApproverEnabled(),
  };
}

// ---------------------------------------------------------------- 15.D6 two-person global kill
//
// Spec 19.2 Rollback: "If systemic (bad provider integration, cost runaway), trigger global
// generation kill with two-person approval."
//
//   PUT /admin/kill-switch {level:"global", enabled:true}   → 202, a pending request (10 minutes)
//   POST /admin/kill-switch/global/confirm {requestId, reason}
//                                                           → a DIFFERENT staff user engages it
//   DELETE /admin/kill-switch/global/pending                → withdraw the request
//
// The request lives in its own system_flags row (PENDING_GLOBAL_KILL_KEY, a JSON value). It never
// touches `studio.killSwitch`, whose non-'true'/'false' values fail closed in every worker.
// Releasing the global kill (enabled:false) stays single-person: it restores service, and
// holding a halt hostage to a second approver would extend an outage. The other levels are
// unchanged. Break-glass: STUDIO_KILL_SWITCH_SINGLE_APPROVER=true engages immediately, audited
// with breakGlass: true.

export const PENDING_GLOBAL_KILL_KEY = 'studio.pendingGlobalKill';
export const GLOBAL_KILL_CONFIRM_WINDOW_MS = 10 * 60 * 1000;
export const SINGLE_APPROVER_ENV = 'STUDIO_KILL_SWITCH_SINGLE_APPROVER';

const pendingSchema = z.object({
  requestId: z.string().min(1),
  requestedBy: z.string().min(1),
  reason: z.string(),
  requestedAt: z.string(),
  expiresAt: z.string(),
});

export type PendingGlobalKill = z.infer<typeof pendingSchema>;

export function singleApproverEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[SINGLE_APPROVER_ENV]?.trim().toLowerCase() === 'true';
}

export function parsePending(value: string | undefined): PendingGlobalKill | null {
  if (!value) return null;
  try {
    const parsed = pendingSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function isExpired(request: Pick<PendingGlobalKill, 'expiresAt'>, now: number): boolean {
  const expires = Date.parse(request.expiresAt);
  return Number.isNaN(expires) || expires <= now;
}

export interface KillSwitchActor {
  userId: string;
}

export type KillSwitchChange =
  | { kind: 'set'; flag: SystemFlag; breakGlass: boolean }
  | { kind: 'pending'; pending: PendingGlobalKill };

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** Record a global kill request for a second staff member to confirm within 10 minutes. */
export async function requestGlobalKill(
  db: PrismaClient,
  actor: KillSwitchActor,
  reason: string,
  now: number,
): Promise<PendingGlobalKill> {
  const pending: PendingGlobalKill = {
    requestId: randomUUID(),
    requestedBy: actor.userId,
    reason,
    requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + GLOBAL_KILL_CONFIRM_WINDOW_MS).toISOString(),
  };
  const value = JSON.stringify(pending);
  const existing = await db.systemFlag.findUnique({ where: { key: PENDING_GLOBAL_KILL_KEY } });
  if (existing) {
    const current = parsePending(existing.value);
    if (current && !isExpired(current, now)) {
      throw new ConflictError(
        'A global kill request is already waiting for a second staff member',
        { pending: current },
      );
    }
    // Replace the expired (or unreadable) request, unless someone else replaced it first.
    const replaced = await db.systemFlag.updateMany({
      where: { key: PENDING_GLOBAL_KILL_KEY, value: existing.value },
      data: { value },
    });
    if (replaced.count === 0) throw new ConflictError('Another global kill request was just made');
    return pending;
  }
  try {
    await db.systemFlag.create({ data: { key: PENDING_GLOBAL_KILL_KEY, value } });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ConflictError('Another global kill request was just made');
    throw err;
  }
  return pending;
}

/**
 * PUT /admin/kill-switch: engaging the global level becomes a pending request (unless it is
 * already engaged, or break-glass is on); every other change applies immediately.
 */
export async function changeKillSwitch(
  db: PrismaClient,
  actor: KillSwitchActor,
  input: z.infer<typeof setKillSwitchInput>,
  now: number,
  env: Record<string, string | undefined> = process.env,
): Promise<KillSwitchChange> {
  if (input.level === 'global' && input.enabled) {
    const current = await db.systemFlag.findUnique({ where: { key: flagKeys.global() } });
    if (current?.value === FLAG_ON) return { kind: 'set', flag: current, breakGlass: false };
    if (!singleApproverEnabled(env)) {
      return { kind: 'pending', pending: await requestGlobalKill(db, actor, input.reason, now) };
    }
    return { kind: 'set', flag: await setKillSwitch(db, input), breakGlass: true };
  }
  return { kind: 'set', flag: await setKillSwitch(db, input), breakGlass: false };
}

export const confirmGlobalKillInput = z
  .object({
    /** The request the confirmer reviewed: a replaced request is not confirmed by accident. */
    requestId: z.string().trim().min(1).max(64),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

async function currentRequest(db: PrismaClient) {
  const row = await db.systemFlag.findUnique({ where: { key: PENDING_GLOBAL_KILL_KEY } });
  const request = parsePending(row?.value);
  if (!row || !request) throw new NotFoundError('No global kill request is pending');
  return { row, request };
}

/** A different staff member confirms: the pending row is consumed and the global flag set. */
export async function confirmGlobalKill(
  db: PrismaClient,
  actor: KillSwitchActor,
  input: z.infer<typeof confirmGlobalKillInput>,
  now: number,
): Promise<{ flag: SystemFlag; request: PendingGlobalKill }> {
  const { row, request } = await currentRequest(db);
  if (request.requestId !== input.requestId) {
    throw new ConflictError('The pending global kill request has changed; review it again', {
      pending: request,
    });
  }
  if (request.requestedBy === actor.userId) {
    throw new ForbiddenError('A different staff member must confirm a global kill (spec 19.2)');
  }
  if (isExpired(request, now)) {
    await db.systemFlag.deleteMany({ where: { key: PENDING_GLOBAL_KILL_KEY, value: row.value } });
    throw new ConflictError('The global kill request expired; request it again', {
      reason: 'expired',
      expiresAt: request.expiresAt,
    });
  }
  const flag = await db.$transaction(async (tx) => {
    const consumed = await tx.systemFlag.deleteMany({
      where: { key: PENDING_GLOBAL_KILL_KEY, value: row.value },
    });
    if (consumed.count === 0) {
      throw new ConflictError('The global kill request was already confirmed or withdrawn');
    }
    const key = flagKeys.global();
    return tx.systemFlag.upsert({
      where: { key },
      create: { key, value: FLAG_ON },
      update: { value: FLAG_ON },
    });
  });
  return { flag, request };
}

/** Withdraw the pending request (any staff member with kill-switch write). */
export async function cancelGlobalKillRequest(db: PrismaClient): Promise<PendingGlobalKill> {
  const { row, request } = await currentRequest(db);
  const removed = await db.systemFlag.deleteMany({
    where: { key: PENDING_GLOBAL_KILL_KEY, value: row.value },
  });
  if (removed.count === 0) {
    throw new ConflictError('The request was already confirmed or withdrawn');
  }
  return request;
}
