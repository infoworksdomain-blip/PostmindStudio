import type { PrismaClient } from '@prisma/client';
import { findFootageClip, HOOK_LIBRARY_CATEGORIES } from './footage';
import { HOOK_DEFAULT_SEC } from './hook-demo';

// BACKLOG 22.1 × 22.4 / 22.5 — when Blitz and automations may offer a hook + demo card for a
// business. Cards are made BEFORE anyone keeps them (blitz/formats.ts tier "premade"), so the
// card must never pay for a generated (Veo) reaction clip: it is offered only when the business
// has a ready demo video (Fastlane's no_demo_video rule) AND a FOOTAGE-licensed reaction clip
// exists in the reference library, and the card's project then takes its hook from the library
// (hookSource "library"). Otherwise the format is skipped for that business. An owner can still
// make an AI-creator hook + demo video from Create, where generating is an explicit choice.

type Db = Pick<PrismaClient, 'videoUpload' | 'videoLibraryItem'>;

export interface HookDemoReadiness {
  demoVideo: boolean;
  libraryHook: boolean;
}

export async function hookDemoReadiness(
  db: Db,
  input: { organisationId: string; businessId: string; now: Date },
): Promise<HookDemoReadiness> {
  const demos = await db.videoUpload.count({
    where: {
      organisationId: input.organisationId,
      businessId: input.businessId,
      kind: 'DEMO_VIDEO',
      state: 'READY',
    },
  });
  if (demos === 0) return { demoVideo: false, libraryHook: false };
  const clip = await findFootageClip(db, {
    categories: HOOK_LIBRARY_CATEGORIES,
    minSec: HOOK_DEFAULT_SEC,
    aspectRatio: '9:16',
    seed: input.businessId,
    now: input.now,
  });
  return { demoVideo: true, libraryHook: clip !== null };
}

/** Blitz / automations may make a hook + demo card for this business (no paid clip). */
export const canMakeHookDemoCard = (r: HookDemoReadiness): boolean => r.demoVideo && r.libraryHook;
