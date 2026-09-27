import { afterEach, describe, expect, it, vi } from 'vitest';
import { KillSwitchTriggeredError } from '../errors';
import { logger } from '../logger';
import {
  createKillSwitch,
  createPrismaFlagStore,
  KILL_SWITCH_CACHE_TTL_MS,
  type FlagStore,
} from './kill-switch';
import { flagKeys } from './system-flags';

const scope = { organisationId: 'org-1', projectId: 'proj-1', providerId: 'runway' };

function memoryStore(initial: Record<string, string> = {}) {
  const flags = new Map(Object.entries(initial));
  const getFlags = vi.fn(async (keys: readonly string[]) => {
    const result = new Map<string, string>();
    for (const key of keys) {
      const value = flags.get(key);
      if (value !== undefined) result.set(key, value);
    }
    return result;
  });
  const store: FlagStore = { getFlags };
  return { store, flags, getFlags };
}

afterEach(() => vi.restoreAllMocks());

describe('kill switch — four levels', () => {
  it('is not killed when no flags are set', async () => {
    const { store } = memoryStore();
    await expect(createKillSwitch({ store }).check(scope)).resolves.toEqual({ killed: false });
  });

  it('is not killed when every flag is explicitly off', async () => {
    const { store } = memoryStore({
      [flagKeys.global()]: 'false',
      [flagKeys.workspace('org-1')]: 'false',
      [flagKeys.project('proj-1')]: 'false',
      [flagKeys.provider('runway')]: 'false',
    });
    await expect(createKillSwitch({ store }).check(scope)).resolves.toEqual({ killed: false });
  });

  it.each([
    ['global', flagKeys.global()],
    ['workspace', flagKeys.workspace('org-1')],
    ['project', flagKeys.project('proj-1')],
    ['provider', flagKeys.provider('runway')],
  ] as const)('level %s stops work when its flag is on', async (level, key) => {
    const { store } = memoryStore({ [key]: 'true' });
    const ks = createKillSwitch({ store });
    await expect(ks.check(scope)).resolves.toEqual({ killed: true, level, key });
    const err = await ks.assertNotKilled(scope).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KillSwitchTriggeredError);
    expect((err as KillSwitchTriggeredError).level).toBe(level);
  });

  it('reports the broadest active level first', async () => {
    const { store } = memoryStore({
      [flagKeys.provider('runway')]: 'true',
      [flagKeys.global()]: 'true',
    });
    await expect(createKillSwitch({ store }).check(scope)).resolves.toMatchObject({
      level: 'global',
    });
  });

  it('only affects the matching workspace, project and provider', async () => {
    const { store } = memoryStore({
      [flagKeys.workspace('org-2')]: 'true',
      [flagKeys.project('proj-2')]: 'true',
      [flagKeys.provider('luma')]: 'true',
    });
    await expect(createKillSwitch({ store }).check(scope)).resolves.toEqual({ killed: false });
  });

  it('skips project and provider levels when the scope omits them', async () => {
    const { store, getFlags } = memoryStore();
    await createKillSwitch({ store }).check({ organisationId: 'org-1' });
    expect(getFlags).toHaveBeenCalledWith([flagKeys.global(), flagKeys.workspace('org-1')]);
  });

  it('includes scope details on the thrown error', async () => {
    const { store } = memoryStore({ [flagKeys.project('proj-1')]: 'true' });
    const err = (await createKillSwitch({ store })
      .assertNotKilled(scope)
      .catch((e: unknown) => e)) as KillSwitchTriggeredError;
    expect(err.details).toEqual({
      key: flagKeys.project('proj-1'),
      organisationId: 'org-1',
      projectId: 'proj-1',
      providerId: 'runway',
      level: 'project',
    });
  });

  it('resolves without throwing when nothing is killed', async () => {
    const { store } = memoryStore();
    await expect(createKillSwitch({ store }).assertNotKilled(scope)).resolves.toBeUndefined();
  });
});

describe('kill switch — platform level (publishing)', () => {
  it('halts a publish scope for the killed platform only', async () => {
    const { store } = memoryStore({ [flagKeys.platform('tiktok')]: 'true' });
    const ks = createKillSwitch({ store });
    const tiktok = { organisationId: 'org-1', projectId: 'proj-1', platform: 'tiktok' };
    await expect(ks.check(tiktok)).resolves.toEqual({
      killed: true,
      level: 'platform',
      key: flagKeys.platform('tiktok'),
    });
    await expect(ks.check({ ...tiktok, platform: 'youtube_short' })).resolves.toEqual({
      killed: false,
    });
    const err = (await ks
      .assertNotKilled(tiktok)
      .catch((e: unknown) => e)) as KillSwitchTriggeredError;
    expect(err).toBeInstanceOf(KillSwitchTriggeredError);
    expect(err.level).toBe('platform');
    expect(err.details).toMatchObject({ platform: 'tiktok', level: 'platform' });
  });

  it('does not affect generation scopes (no platform in the scope)', async () => {
    const { store, getFlags } = memoryStore({ [flagKeys.platform('tiktok')]: 'true' });
    await expect(createKillSwitch({ store }).check(scope)).resolves.toEqual({ killed: false });
    expect(getFlags.mock.calls[0]?.[0]).not.toContain(flagKeys.platform('tiktok'));
  });
});

describe('kill switch — safety', () => {
  it('fails closed on unrecognised flag values', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { store } = memoryStore({ [flagKeys.global()]: 'yes' });
    await expect(createKillSwitch({ store }).check(scope)).resolves.toMatchObject({
      killed: true,
      level: 'global',
    });
    expect(warn).toHaveBeenCalled();
  });

  it('propagates store errors instead of assuming the switch is off', async () => {
    const store: FlagStore = { getFlags: vi.fn().mockRejectedValue(new Error('db down')) };
    await expect(createKillSwitch({ store }).assertNotKilled(scope)).rejects.toThrow('db down');
  });
});

describe('kill switch — 30s cache', () => {
  it('uses a 30 second TTL by default', () => {
    expect(KILL_SWITCH_CACHE_TTL_MS).toBe(30_000);
  });

  it('serves cached values within the TTL and re-reads after it', async () => {
    let now = 0;
    const { store, flags, getFlags } = memoryStore();
    const ks = createKillSwitch({ store, now: () => now });

    await ks.check(scope);
    flags.set(flagKeys.global(), 'true');
    now = 29_999;
    await expect(ks.check(scope)).resolves.toEqual({ killed: false });
    expect(getFlags).toHaveBeenCalledTimes(1);

    now = 30_000;
    await expect(ks.check(scope)).resolves.toMatchObject({ killed: true, level: 'global' });
    expect(getFlags).toHaveBeenCalledTimes(2);
  });

  it('only fetches keys that are not already cached', async () => {
    const { store, getFlags } = memoryStore();
    const ks = createKillSwitch({ store, now: () => 0 });
    await ks.check({ organisationId: 'org-1' });
    await ks.check(scope);
    expect(getFlags).toHaveBeenLastCalledWith([
      flagKeys.project('proj-1'),
      flagKeys.provider('runway'),
    ]);
  });

  it('invalidate() forces a fresh read', async () => {
    const { store, flags } = memoryStore();
    const ks = createKillSwitch({ store, now: () => 0 });
    await ks.check(scope);
    flags.set(flagKeys.workspace('org-1'), 'true');
    ks.invalidate();
    await expect(ks.check(scope)).resolves.toMatchObject({ level: 'workspace' });
  });
});

describe('createPrismaFlagStore', () => {
  it('queries system_flags for exactly the requested keys', async () => {
    const findMany = vi.fn(async () => [{ key: 'studio.killSwitch', value: 'true' }]);
    const store = createPrismaFlagStore({ systemFlag: { findMany } });
    const flags = await store.getFlags(['studio.killSwitch', 'studio.frozenWorkspace.o']);
    expect(findMany).toHaveBeenCalledWith({
      where: { key: { in: ['studio.killSwitch', 'studio.frozenWorkspace.o'] } },
      select: { key: true, value: true },
    });
    expect(flags.get('studio.killSwitch')).toBe('true');
    expect(flags.has('studio.frozenWorkspace.o')).toBe(false);
  });
});
