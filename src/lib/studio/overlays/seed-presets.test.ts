import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { BUILT_IN_PRESETS } from './presets';
import { seedOverlayPresets } from './seed-presets';

function fakeDb(existingNames: string[] = []) {
  const findFirst = vi.fn(async ({ where }: { where: { scope: string; name: string } }) =>
    existingNames.includes(where.name) ? { id: `id-${where.name}` } : null,
  );
  const create = vi.fn(
    async (_args: { data: { scope: string; isPublic: boolean } }) => ({}) as unknown,
  );
  const update = vi.fn(async () => ({}));
  const db = { overlayPreset: { findFirst, create, update } } as unknown as PrismaClient;
  return { db, findFirst, create, update };
}

describe('seedOverlayPresets', () => {
  it('creates every preset when none exist yet', async () => {
    const { db, create, update } = fakeDb([]);
    const created = await seedOverlayPresets(db);
    expect(created).toBe(BUILT_IN_PRESETS.length);
    expect(create).toHaveBeenCalledTimes(BUILT_IN_PRESETS.length);
    expect(update).not.toHaveBeenCalled();
  });

  it('updates presets that already exist instead of creating them', async () => {
    const existingName = BUILT_IN_PRESETS[0]?.name as string;
    const { db, create, update } = fakeDb([existingName]);
    const created = await seedOverlayPresets(db);
    expect(created).toBe(BUILT_IN_PRESETS.length - 1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(BUILT_IN_PRESETS.length - 1);
  });

  it('looks up existing presets scoped to BUILT_IN by name', async () => {
    const { db, findFirst } = fakeDb([]);
    await seedOverlayPresets(db);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scope: 'BUILT_IN', name: BUILT_IN_PRESETS[0]?.name } }),
    );
  });

  it('updates using the existing row id', async () => {
    const existingName = BUILT_IN_PRESETS[0]?.name as string;
    const { db, update } = fakeDb([existingName]);
    await seedOverlayPresets(db);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: `id-${existingName}` } }),
    );
  });

  it('creates with scope BUILT_IN and isPublic true', async () => {
    const { db, create } = fakeDb([]);
    await seedOverlayPresets(db);
    const call = create.mock.calls[0]?.[0];
    expect(call?.data).toMatchObject({ scope: 'BUILT_IN', isPublic: true });
  });

  it('returns 0 created when every preset already exists', async () => {
    const { db } = fakeDb(BUILT_IN_PRESETS.map((p) => p.name));
    const created = await seedOverlayPresets(db);
    expect(created).toBe(0);
  });
});
