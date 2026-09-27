import type { Prisma, PrismaClient } from '@prisma/client';
import { BUILT_IN_TEMPLATES } from './templates';

// BACKLOG 7.4 — built-in slideshow templates (organisationId = null). Idempotent: a template
// whose category already exists as a built-in is updated in place (so plan fixes ship with a
// re-seed); custom organisation templates are never touched.

export async function seedSlideshowTemplates(db: PrismaClient): Promise<number> {
  let created = 0;
  for (const template of BUILT_IN_TEMPLATES) {
    const data = {
      name: template.name,
      slidePlan: template.slidePlan as unknown as Prisma.InputJsonValue,
      musicMood: template.musicMood,
      defaultDurationPerSlide: template.defaultDurationPerSlide,
      overlayDefaults: template.overlayDefaults as Prisma.InputJsonValue,
    };
    const existing = await db.slideshowTemplate.findFirst({
      where: { organisationId: null, category: template.category },
      select: { id: true },
    });
    if (existing) {
      await db.slideshowTemplate.update({ where: { id: existing.id }, data });
    } else {
      await db.slideshowTemplate.create({ data: { ...data, category: template.category } });
      created += 1;
    }
  }
  return created;
}
