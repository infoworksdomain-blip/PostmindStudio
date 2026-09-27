import { KillSwitchTriggeredError, type KillSwitchLevel } from '../errors';
import { logger } from '../logger';
import { FLAG_OFF, FLAG_ON, flagKeys } from './system-flags';

// Four-level kill switch (spec 4.6 / 12, Engagement handover 12), plus a per-platform publishing
// level (Phase 12). DB-backed via
// studio.system_flags so it is multi-instance safe; each process caches flag reads for 30s,
// which bounds the time-to-effect. Every worker calls assertNotKilled() on job start.

export const KILL_SWITCH_CACHE_TTL_MS = 30_000;

export interface KillSwitchScope {
  organisationId: string;
  projectId?: string;
  providerId?: string;
  /** Publishing platform (level 5): only publish jobs pass it, so generation is unaffected. */
  platform?: string;
}

export type KillSwitchStatus =
  { killed: false } | { killed: true; level: KillSwitchLevel; key: string };

/** Reads raw flag values. Keys absent from the result are treated as "off". */
export interface FlagStore {
  getFlags(keys: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

export interface KillSwitch {
  check(scope: KillSwitchScope): Promise<KillSwitchStatus>;
  assertNotKilled(scope: KillSwitchScope): Promise<void>;
  /** Drop cached values, e.g. right after an operator toggles a flag in this process. */
  invalidate(): void;
}

interface CacheEntry {
  value: string | undefined;
  expiresAt: number;
}

function levelKeys(scope: KillSwitchScope): Array<{ level: KillSwitchLevel; key: string }> {
  const keys: Array<{ level: KillSwitchLevel; key: string }> = [
    { level: 'global', key: flagKeys.global() },
    { level: 'workspace', key: flagKeys.workspace(scope.organisationId) },
  ];
  if (scope.projectId) keys.push({ level: 'project', key: flagKeys.project(scope.projectId) });
  if (scope.providerId) keys.push({ level: 'provider', key: flagKeys.provider(scope.providerId) });
  if (scope.platform) keys.push({ level: 'platform', key: flagKeys.platform(scope.platform) });
  return keys;
}

/** 'true' = on, 'false' or absent = off. Anything else fails closed (treated as on). */
function isOn(key: string, value: string | undefined): boolean {
  if (value === undefined || value === FLAG_OFF) return false;
  if (value !== FLAG_ON) {
    logger.warn({ key, value }, '[kill-switch] unrecognised flag value; failing closed');
  }
  return true;
}

export function createKillSwitch(deps: {
  store: FlagStore;
  now?: () => number;
  ttlMs?: number;
}): KillSwitch {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? KILL_SWITCH_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  async function readFlags(keys: readonly string[]): Promise<Map<string, string | undefined>> {
    const values = new Map<string, string | undefined>();
    const stale: string[] = [];
    for (const key of keys) {
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) values.set(key, hit.value);
      else stale.push(key);
    }
    if (stale.length > 0) {
      // Store errors propagate: without a readable flag we cannot prove the switch is off.
      const fetched = await deps.store.getFlags(stale);
      const expiresAt = now() + ttlMs;
      for (const key of stale) {
        const value = fetched.get(key);
        cache.set(key, { value, expiresAt });
        values.set(key, value);
      }
    }
    return values;
  }

  async function check(scope: KillSwitchScope): Promise<KillSwitchStatus> {
    const levels = levelKeys(scope);
    const values = await readFlags(levels.map((l) => l.key));
    const hit = levels.find(({ key }) => isOn(key, values.get(key)));
    return hit ? { killed: true, level: hit.level, key: hit.key } : { killed: false };
  }

  return {
    check,
    async assertNotKilled(scope) {
      const status = await check(scope);
      if (status.killed) {
        throw new KillSwitchTriggeredError(
          status.level,
          `Studio kill switch active (${status.level})`,
          {
            key: status.key,
            organisationId: scope.organisationId,
            ...(scope.projectId && { projectId: scope.projectId }),
            ...(scope.providerId && { providerId: scope.providerId }),
            ...(scope.platform && { platform: scope.platform }),
          },
        );
      }
    },
    invalidate() {
      cache.clear();
    },
  };
}

/** FlagStore backed by studio.system_flags. */
export function createPrismaFlagStore(client: {
  systemFlag: {
    findMany(args: {
      where: { key: { in: string[] } };
      select: { key: true; value: true };
    }): Promise<Array<{ key: string; value: string }>>;
  };
}): FlagStore {
  return {
    async getFlags(keys) {
      const rows = await client.systemFlag.findMany({
        where: { key: { in: [...keys] } },
        select: { key: true, value: true },
      });
      return new Map(rows.map((row) => [row.key, row.value]));
    },
  };
}

let defaultKillSwitch: KillSwitch | undefined;

/** Process-wide kill switch backed by Prisma. */
export async function getKillSwitch(): Promise<KillSwitch> {
  if (!defaultKillSwitch) {
    const { prisma } = await import('../prisma');
    defaultKillSwitch = createKillSwitch({ store: createPrismaFlagStore(prisma) });
  }
  return defaultKillSwitch;
}
