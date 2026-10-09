import { describe, expect, it } from 'vitest';
import { planDisplayName, topUpPackName } from './email-params';

describe('billing email params', () => {
  it('names a video pack in the reader’s language (21.5: HD video packs)', async () => {
    expect(await topUpPackName({ kind: 'short', quantity: 15 }, 'en-GB')).toBe('15 HD videos');
    expect(await topUpPackName({ kind: 'short', quantity: 1 }, 'en-GB')).toBe('1 HD video');
    expect(await topUpPackName({ kind: 'long', quantity: 1 }, 'en-GB')).toBe('1 long video');
    const fr = await topUpPackName({ kind: 'short', quantity: 15 }, 'fr');
    expect(fr).toContain('15');
  });

  it('falls back to en-GB for an unknown locale', async () => {
    expect(await topUpPackName({ kind: 'short', quantity: 5 }, 'xx')).toBe('5 HD videos');
  });

  it('turns a tier or lookup key into the plan name; the channel plan is the product name', () => {
    expect(planDisplayName('studio_growth_monthly')).toBe('Growth');
    expect(planDisplayName('studio_pro_weekly')).toBe('Pro');
    // A 21.5 channel price is named by the plan its quantity maps to.
    expect(planDisplayName('studio_channel_monthly')).toBe('Starter');
    expect(planDisplayName('studio_channel_monthly', 3)).toBe('Growth');
    expect(planDisplayName('studio_channel_yearly', 6)).toBe('Pro');
    expect(planDisplayName('STANDARD')).toBe('PostMind Studio');
    expect(planDisplayName('studio_plus_yearly')).toBe('Plus');
    expect(planDisplayName(null)).toBeNull();
    expect(planDisplayName('  ')).toBeNull();
  });
});
