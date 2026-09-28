import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import type { CoreContent, CoreContentClient } from '../core/content-client';
import { targetFormatInput } from './catalog';
import { organisationIdParam } from './org-policy';
import { createProject, createProjectInput } from './projects';

// BACKLOG 15.W1 — POST /api/studio/internal/projects/from-content (spec 8.8: "Called by
// PostMind Core when a user says 'make a video from this post'. Body: { organisationId, userId,
// contentId, targetFormats[] }"). Final contract: Studio fetches the content from Core
// (core/content-client.ts), then creates a DRAFT project (sourceType POSTMIND_CONTENT, sourceRef =
// contentId, the post text as the brief) that the user reviews and generates from Studio.
// Until Core publishes GET /api/internal/content/:id the fetch throws NotImplementedError and the
// endpoint answers an honest 501 — nothing is created. businessId is optional in the body (the
// spec body has none) and falls back to the content's own business.

export const fromContentInput = z
  .object({
    organisationId: organisationIdParam,
    userId: z.string().trim().min(1).max(128),
    businessId: z.string().trim().min(1).max(128).optional(),
    contentId: z.string().trim().min(1).max(128),
    targetFormats: z.array(targetFormatInput).min(1).max(10),
  })
  .strict();

export type FromContentInput = z.infer<typeof fromContentInput>;

/** The brief text Layer 1 starts from: title, body and product facts as Core returned them. */
export function contentBrief(content: CoreContent): string {
  const product = content.product
    ? `Product: ${content.product.name}${content.product.price ? ` (${content.product.price})` : ''}`
    : null;
  return [content.title, content.text, product]
    .filter((part): part is string => Boolean(part?.trim()))
    .join('\n\n')
    .slice(0, 4_000);
}

export async function createProjectFromContent(
  deps: { db: PrismaClient; content: CoreContentClient },
  input: FromContentInput,
) {
  const content = await deps.content.getContent({
    organisationId: input.organisationId,
    contentId: input.contentId,
  });
  // Core must only ever return the caller's content; refuse anything else.
  if (content.organisationId !== input.organisationId) throw new NotFoundError('Content not found');
  const businessId = input.businessId ?? content.businessId;
  if (!businessId) throw new ValidationError('businessId is required (the content has none)');
  const brief = contentBrief(content);
  if (!brief) throw new ValidationError('The content has no text to make a video from');
  // Core acts for the user: the project is theirs, with only the rights a create needs.
  const tenant: TenantContext = {
    userId: input.userId,
    organisationId: input.organisationId,
    organisation: { id: input.organisationId },
    memberships: [],
    capabilities: ['studio:project:write'],
  };
  const project = await createProject(
    deps.db,
    tenant,
    createProjectInput.parse({
      name: (content.title ?? content.text).trim().slice(0, 80) || 'Video from PostMind post',
      businessId,
      sourceType: 'POSTMIND_CONTENT',
      sourceRef: content.id,
      brief: { rawInput: brief },
      targetFormats: input.targetFormats,
    }),
  );
  return { project: { id: project.id, state: project.state, sourceRef: project.sourceRef } };
}
