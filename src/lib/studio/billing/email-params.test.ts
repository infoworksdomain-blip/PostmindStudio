import { describe, expect, it } from 'vitest';
import { planDisplayName, topUpPackName } from './email-params';

describe('billing email params', () => {
  it('names a top-up pack in the reader’s language', async () => {
    expect(await topUpPackName({ kind: 'short', quantity: 10 }, 'en-GB')).toBe('10 short videos');
    expect(await topUpPackName({ kind: 'long', quantity: 1 }, 'en-GB')).toBe('1 long video');
    const fr = await topUpPackName({ kind: 'short', quantity: 10 }, 'fr');
    expect(fr).toContain('10');
    expect(fr).not.toBe('10 short videos');
  });

  it('falls back to en-GB for an unknown locale', async () => {
    expect(await topUpPackName({ kind: 'short', quantity: 2 }, 'xx')).toBe('2 short videos');
  });

  it('turns a tier or lookup key into the plan name', () => {
    expect(planDisplayName('STANDARD')).toBe('Standard');
    expect(planDisplayName('studio_plus_yearly')).toBe('Plus');
    expect(planDisplayName(null)).toBeNull();
    expect(planDisplayName('  ')).toBeNull();
  });
});
