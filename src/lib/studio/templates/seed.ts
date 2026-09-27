import type { Prisma, PrismaClient } from '@prisma/client';
import type { PublishDefaults } from '../automation/targets';
import type { TemplateBlueprint } from './blueprint';

// Built-in project templates (organisationId = null). Spec 14.5 first-run: "Generate first video —
// using a pre-seeded template ("Introduce yourself and what you do")". Idempotent by name: a
// built-in that already exists is updated in place; organisation templates are never touched.

export interface BuiltInTemplate {
  name: string;
  category: string;
  targetFormats: Array<{ platform: string; aspectRatio: string; duration: number }>;
  scriptTemplate: string;
  shotBlueprint: TemplateBlueprint;
  publishDefaults: PublishDefaults;
}

export const INTRODUCE_YOURSELF: BuiltInTemplate = {
  name: 'Introduce yourself and what you do',
  category: 'introduction',
  targetFormats: [
    { platform: 'tiktok', aspectRatio: '9:16', duration: 30 },
    { platform: 'instagram_reel', aspectRatio: '9:16', duration: 30 },
    { platform: 'youtube_short', aspectRatio: '9:16', duration: 30 },
  ],
  scriptTemplate: [
    'Introduce the business and what it does, in its own voice. {{brief}}',
    'Cover, in order: a friendly hello that names the business; what it offers and who it is for;',
    'one concrete reason to choose it; how to get in touch or buy.',
  ].join('\n'),
  shotBlueprint: {
    shots: [
      {
        durationSec: 4,
        type: 'HOOK_TEXT_ON_STILL',
        overlayStyle: 'bold-centre',
        voiceoverPresent: true,
        hasOnScreenText: true,
      },
      {
        durationSec: 8,
        type: 'AVATAR_TALKING',
        overlayStyle: 'subtitle-lower',
        voiceoverPresent: true,
        hasOnScreenText: false,
      },
      {
        durationSec: 7,
        type: 'B_ROLL',
        overlayStyle: 'subtitle-lower',
        voiceoverPresent: true,
        hasOnScreenText: false,
      },
      {
        durationSec: 6,
        type: 'PRODUCT_SHOT',
        overlayStyle: 'none',
        voiceoverPresent: true,
        hasOnScreenText: false,
      },
      {
        durationSec: 5,
        type: 'CTA_CARD',
        overlayStyle: 'bold-bottom',
        voiceoverPresent: true,
        hasOnScreenText: true,
      },
    ],
    hookPattern: 'friendly hello naming the business, on screen',
    structurePattern: 'hello, what we do, why us, call to action',
    ctaPattern: 'how to get in touch or buy',
    paceTag: 'medium',
  },
  // Spec 5.9: a new user's first videos are reviewed by a person.
  publishDefaults: { publishPolicy: 'MANUAL', reviewPolicy: 'REQUIRE_APPROVAL', targets: [] },
};

export const BUILT_IN_PROJECT_TEMPLATES: BuiltInTemplate[] = [INTRODUCE_YOURSELF];

export async function seedProjectTemplates(db: PrismaClient): Promise<number> {
  let created = 0;
  for (const template of BUILT_IN_PROJECT_TEMPLATES) {
    const data = {
      category: template.category,
      targetFormats: template.targetFormats as Prisma.InputJsonValue,
      scriptTemplate: template.scriptTemplate,
      shotBlueprint: template.shotBlueprint as unknown as Prisma.InputJsonValue,
      publishDefaults: template.publishDefaults as unknown as Prisma.InputJsonValue,
      isPublic: true,
    };
    const existing = await db.template.findFirst({
      where: { organisationId: null, name: template.name },
      select: { id: true },
    });
    if (existing) {
      await db.template.update({ where: { id: existing.id }, data });
    } else {
      await db.template.create({ data: { ...data, name: template.name } });
      created += 1;
    }
  }
  return created;
}
