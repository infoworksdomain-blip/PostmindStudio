import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ForbiddenError, NotFoundError, ValidationError } from '../../errors';

// BACKLOG 15.E7 — Addendum A5.4 "Users can save custom slideshows as their own templates for
// reuse (studio.postmind.ai/templates)": the templates screen lists and deletes them. Built-in
// templates (organisationId null) are read-only; another organisation's template is a 404 (its
// existence is not revealed). Projects keep the slides they were built with: a template is only a
// blueprint (services/slideshows.ts saveTemplate copies no content), so nothing references it.

const templateIdParam = z.string().trim().min(1).max(64);

export async function deleteSlideshowTemplate(
  db: Pick<PrismaClient, 'slideshowTemplate'>,
  organisationId: string,
  id: string,
): Promise<{ id: string; name: string }> {
  const parsed = templateIdParam.safeParse(id);
  if (!parsed.success) throw new ValidationError('Invalid template id');
  const template = await db.slideshowTemplate.findFirst({
    where: { id: parsed.data, OR: [{ organisationId: null }, { organisationId }] },
    select: { id: true, name: true, organisationId: true },
  });
  if (!template) throw new NotFoundError('Template not found');
  if (template.organisationId === null)
    throw new ForbiddenError('Built-in templates cannot be deleted');
  const deleted = await db.slideshowTemplate.deleteMany({
    where: { id: template.id, organisationId },
  });
  if (deleted.count === 0) throw new NotFoundError('Template not found');
  return { id: template.id, name: template.name };
}
