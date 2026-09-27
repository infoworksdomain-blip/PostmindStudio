import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

describe('test harness', () => {
  it('runs vitest and resolves project TypeScript modules', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
