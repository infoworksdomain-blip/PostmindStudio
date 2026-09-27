import { describe, expect, it, vi } from 'vitest';
import { seedSystemFlags } from './seed-system-flags';
import { defaultSystemFlags, flagKeys, PROVIDER_IDS } from './system-flags';

describe('flagKeys', () => {
  it('builds one namespaced key per level', () => {
    expect(flagKeys.global()).toBe('studio.killSwitch');
    expect(flagKeys.workspace('org-1')).toBe('studio.frozenWorkspace.org-1');
    expect(flagKeys.project('p-1')).toBe('studio.killedProject.p-1');
    expect(flagKeys.provider('runway')).toBe('studio.disabledProvider.runway');
    expect(flagKeys.platform('tiktok')).toBe('studio.kill_switch.platform.tiktok');
  });
});

describe('defaultSystemFlags', () => {
  const flags = defaultSystemFlags();

  it('seeds the global kill switch off', () => {
    expect(flags).toContainEqual({ key: 'studio.killSwitch', value: 'false' });
  });

  it('seeds every provider as enabled', () => {
    for (const id of PROVIDER_IDS) {
      expect(flags).toContainEqual({ key: `studio.disabledProvider.${id}`, value: 'false' });
    }
    expect(flags).toHaveLength(PROVIDER_IDS.length + 1);
  });

  it('never seeds a flag in the on state', () => {
    expect(flags.every((f) => f.value === 'false')).toBe(true);
  });

  it('has unique provider ids', () => {
    expect(new Set(PROVIDER_IDS).size).toBe(PROVIDER_IDS.length);
  });
});

describe('seedSystemFlags', () => {
  it('inserts defaults with skipDuplicates so existing values are never overwritten', async () => {
    const createMany = vi.fn(async () => ({ count: 3 }));
    await expect(seedSystemFlags({ systemFlag: { createMany } })).resolves.toBe(3);
    expect(createMany).toHaveBeenCalledWith({
      data: [...defaultSystemFlags()],
      skipDuplicates: true,
    });
  });
});
