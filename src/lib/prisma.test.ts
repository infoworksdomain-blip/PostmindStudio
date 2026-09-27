import { describe, expect, it } from 'vitest';
import { prisma, prismaLogLevels } from './prisma';

describe('prisma singleton', () => {
  it('logs queries only in development', () => {
    expect(prismaLogLevels('development')).toEqual(['query', 'error', 'warn']);
    expect(prismaLogLevels('production')).toEqual(['error']);
    expect(prismaLogLevels(undefined)).toEqual(['error']);
  });

  it('reuses one client across imports outside production', async () => {
    const again = await import('./prisma');
    expect(again.prisma).toBe(prisma);
    expect((globalThis as { studioPrisma?: unknown }).studioPrisma).toBe(prisma);
  });
});
