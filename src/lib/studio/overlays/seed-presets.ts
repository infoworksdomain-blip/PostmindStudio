import type { Prisma, PrismaClient } from '@prisma/client';
import { BUILT_IN_PRESETS } from './presets';

// BACKLOG 8.2 — built-in overlay presets (scope BUILT_IN). Idempotent: matched by name within
// BUILT_IN and updated in place so preset tweaks ship with a re-seed; org/business presets are
// never touched.

export async function seedOverlayPresets(db: PrismaClient): Promise<number> {
  let created = 0;
  for (const preset of BUILT_IN_PRESETS) {
    const data = {
      group: preset.group,
      parameters: preset.parameters as Prisma.InputJsonValue,
      brandSubstitution: preset.brandSubstitution,
      isPublic: true,
    };
    const existing = await db.overlayPreset.findFirst({
      where: { scope: 'BUILT_IN', name: preset.name },
      select: { id: true },
    });
    if (existing) {
      await db.overlayPreset.update({ where: { id: existing.id }, data });
    } else {
      await db.overlayPreset.create({ data: { ...data, scope: 'BUILT_IN', name: preset.name } });
      created += 1;
    }
  }
  return created;
}
