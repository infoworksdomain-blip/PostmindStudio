import { describe, expect, it } from 'vitest';
import {
  DRIP_HORIZON_WEEKS,
  DRIP_PRESET_IDS,
  matchPreset,
  presetPostsPerWeek,
  presetSlots,
} from './drip-presets';
import { DRIP_HORIZON_DAYS, dripQueueInput, MAX_DRIP_SLOTS } from './services/drip-queue';

describe('posting-plan presets (20.3)', () => {
  it('fills weekly slots in the given time zone', () => {
    expect(presetSlots('three', 'Europe/London')).toEqual([
      { weekday: 1, time: '12:30', timezone: 'Europe/London' },
      { weekday: 3, time: '12:30', timezone: 'Europe/London' },
      { weekday: 5, time: '12:30', timezone: 'Europe/London' },
    ]);
    expect(presetSlots('five', 'Africa/Lagos').map((s) => s.weekday)).toEqual([1, 2, 3, 4, 5]);
    const daily = presetSlots('daily', 'Asia/Kolkata');
    expect(daily).toHaveLength(7);
    expect(daily.filter((s) => s.weekday === 0 || s.weekday === 6).map((s) => s.time)).toEqual([
      '09:00',
      '09:00',
    ]);
    expect(DRIP_PRESET_IDS.map(presetPostsPerWeek)).toEqual([3, 5, 7]);
  });

  it('every plan is a valid drip queue within MAX_DRIP_SLOTS', () => {
    for (const id of DRIP_PRESET_IDS) {
      const slots = presetSlots(id, 'America/New_York');
      expect(slots.length).toBeLessThanOrEqual(MAX_DRIP_SLOTS);
      expect(dripQueueInput.safeParse({ slots }).success).toBe(true);
    }
  });

  it('recognises a plan in any order, and nothing else', () => {
    expect(matchPreset([...presetSlots('five', 'UTC')].reverse())).toBe('five');
    expect(matchPreset(presetSlots('daily', 'UTC'))).toBe('daily');
    expect(matchPreset([])).toBeNull();
    const edited = presetSlots('three', 'UTC').map((s, i) =>
      i === 0 ? { ...s, time: '08:00' } : s,
    );
    expect(matchPreset(edited)).toBeNull();
    const mixedZones = presetSlots('three', 'UTC').map((s, i) =>
      i === 0 ? { ...s, timezone: 'Europe/Paris' } : s,
    );
    expect(matchPreset(mixedZones)).toBeNull();
    const duplicated = [...presetSlots('three', 'UTC'), presetSlots('three', 'UTC')[0]!];
    expect(matchPreset(duplicated)).toBeNull();
  });

  it('keeps the client horizon in weeks equal to the service horizon', () => {
    expect(DRIP_HORIZON_WEEKS * 7).toBe(DRIP_HORIZON_DAYS);
  });
});
