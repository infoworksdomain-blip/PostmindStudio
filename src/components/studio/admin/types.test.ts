import { describe, expect, it } from 'vitest';
import { PLATFORMS } from '@/lib/studio/services/catalog';
import { PUBLISH_PLATFORMS } from './types';

describe('admin PUBLISH_PLATFORMS', () => {
  it('lists every platform the server can publish to, so each can be halted from the Admin Centre', () => {
    expect([...PUBLISH_PLATFORMS].sort()).toEqual([...PLATFORMS].sort());
  });

  it('includes the 15.A1 feed destinations', () => {
    expect(PUBLISH_PLATFORMS).toContain('instagram_feed');
    expect(PUBLISH_PLATFORMS).toContain('facebook_feed');
  });
});
