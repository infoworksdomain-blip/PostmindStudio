import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { isUgcLanguage, newUgcStyle, SETTING_TEXT, actorDescription } from './style';
import {
  UGC_AGE_RANGES,
  UGC_GENDERS,
  UGC_SETTINGS,
  MAX_UGC_SEED,
  type UgcAgeRange,
  type UgcGender,
  type UgcSetting,
  type UgcStyle,
} from './style';
import { ACTOR_LINE_ONCE, maxWordsFor } from './prompt';
import { parseActorImageState, type PortraitStore } from './portrait';
import { checkRealPersonRequest } from './real-person';

// BACKLOG 23.2 (operator decision 2026-10-06: "HeyGen should be used as a back-up; we have
// Seedance and other models that are better and cost less") — an AI_AVATAR shot (an on-screen
// presenter in an ordinary AI video) is made like a UGC actor clip first: a generated person speaks
// the shot's line natively on camera (actor_video: Veo 3.1 Fast, then Kling with native audio,
// router.ts ACTOR_CANDIDATES), with the business's default reusable creator (22.3) when it has one,
// else a one-off generated presenter whose portrait is made once per project (21.4a, stored at
// metadata.presenter.actorImage so the project never becomes a UGC project). Only when no actor
// provider can make the clip does the shot go to HeyGen / D-ID (lip-sync to the brand voice), and
// only when those are unavailable too does it degrade to narrated B-roll (20.19).
//
// The actor route is skipped (straight to HeyGen) when it could not make an equivalent shot:
//   - the line is not English (actors speak English only, ugc/style.ts UGC_LANGUAGES);
//   - the line does not fit the shot when spoken by an actor (ugc/prompt.ts maxWordsFor), since
//     the clip cannot be re-paced like narration;
//   - the shot is outside the actor clip lengths (4–8 s, Veo; Kling takes 3–15 s);
//   - the scene describes a real or named person (ugc/real-person.ts);
//   - the owner regenerated the shot on HeyGen / D-ID explicitly.
// A brand's own custom HeyGen avatar keeps HeyGen first (router.ts presenterRoute): no such avatar
// is stored yet, so the flag is always false today.

/** Where a presenter project keeps its portrait state (not metadata.ugc: it is not a UGC video). */
export const PRESENTER_KEY = 'presenter';
/** Actor clip lengths a presenter shot may have (Veo renders up to 8 s). */
export const PRESENTER_MIN_SEC = 4;
export const PRESENTER_MAX_SEC = 8;

/** A stable seed per project, so every presenter clip of the video describes the same person. */
export function presenterSeed(projectId: string): number {
  const digest = createHash('sha256').update(`presenter:${projectId}`).digest();
  return digest.readUInt32BE(0) % (MAX_UGC_SEED + 1);
}

function oneOf<T extends string>(list: readonly T[], value: string): T | null {
  return (list as readonly string[]).includes(value) ? (value as T) : null;
}

type CreatorDb = Pick<PrismaClient, 'creator'>;

/**
 * The presenter's look: the business's default READY creator with a portrait (22.3), else a
 * one-off generated person picked from the project's seed (no product: a presenter is not a
 * product review).
 */
export async function loadPresenterStyle(
  db: CreatorDb,
  project: { id: string; organisationId: string; businessId: string },
): Promise<UgcStyle> {
  const seed = presenterSeed(project.id);
  const creator = await db.creator.findFirst({
    where: {
      organisationId: project.organisationId,
      businessId: project.businessId,
      isDefault: true,
      status: 'READY',
      retiredAt: null,
      portraitId: { not: null },
    },
    select: {
      id: true,
      portraitId: true,
      description: true,
      voiceTone: true,
      ageRange: true,
      gender: true,
      setting: true,
    },
  });
  const ageRange = creator ? oneOf<UgcAgeRange>(UGC_AGE_RANGES, creator.ageRange) : null;
  const gender = creator ? oneOf<UgcGender>(UGC_GENDERS, creator.gender) : null;
  const setting = creator ? oneOf<UgcSetting>(UGC_SETTINGS, creator.setting) : null;
  if (creator?.portraitId && ageRange && gender && setting) {
    return newUgcStyle({}, seed, {
      id: creator.id,
      portraitId: creator.portraitId,
      description: creator.description,
      voiceTone: creator.voiceTone,
      ageRange,
      gender,
      setting,
    });
  }
  // A presenter talks to camera at a desk or in a living room, never in a car or bathroom.
  const style = newUgcStyle({}, seed);
  return {
    ...style,
    actor: {
      ...style.actor,
      setting: style.actor.setting === 'kitchen' ? 'desk' : style.actor.setting,
    },
  };
}

export type PresenterSkipReason =
  | 'no_line'
  | 'language'
  | 'line_too_long'
  | 'duration'
  | 'real_person'
  | 'provider_chosen'
  | 'custom_avatar';

/** Whether the actor route can make this presenter shot (null) or why it is skipped. */
export function presenterSkipReason(input: {
  voiceoverText: string | null;
  language: string | null;
  durationSec: number;
  sceneDescription: string;
  cameraDirection?: string | null;
  /** The provider the owner asked for first, if any (shot regenerate / generate body). */
  preferredProviderId?: string;
  actorProviderIds: readonly string[];
  brandHasCustomAvatar?: boolean;
}): PresenterSkipReason | null {
  if (input.brandHasCustomAvatar) return 'custom_avatar';
  if (input.preferredProviderId && !input.actorProviderIds.includes(input.preferredProviderId))
    return 'provider_chosen';
  const line = input.voiceoverText?.trim() ?? '';
  if (!line) return 'no_line';
  if (!isUgcLanguage(input.language)) return 'language';
  if (input.durationSec < PRESENTER_MIN_SEC || input.durationSec > PRESENTER_MAX_SEC)
    return 'duration';
  if (line.split(/\s+/).length > maxWordsFor(input.durationSec)) return 'line_too_long';
  if (checkRealPersonRequest(input.sceneDescription, input.cameraDirection).refused)
    return 'real_person';
  return null;
}

function clean(text: string | null | undefined, max: number): string {
  return (text ?? '').replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, max);
}

/**
 * The clip prompt for a presenter shot (without the spoken line: each adapter adds it in its own
 * documented dialogue form). Creator-style, framed for the video's own aspect ratio.
 */
export function presenterClipPrompt(input: {
  style: UgcStyle;
  sceneDescription: string;
  cameraDirection?: string | null;
  actorReference: boolean;
  aspectRatio: string;
}): string {
  const { style } = input;
  const scene = clean(input.sceneDescription, 400);
  const camera = clean(input.cameraDirection, 120);
  const vertical = input.aspectRatio === '9:16' || input.aspectRatio === '4:5';
  const person = input.actorReference
    ? `The presenter is the same person as in the reference portrait (${actorDescription(style)}), a fictional person, with the same face, hair and clothes, in ${SETTING_TEXT[style.actor.setting]}.`
    : `The presenter is ${actorDescription(style)}, a fictional person, in ${SETTING_TEXT[style.actor.setting]}.`;
  return [
    `${vertical ? 'Vertical' : 'Landscape'} creator-style video, filmed on a phone on a small tripod, natural light, authentic and friendly.`,
    person,
    'They look into the camera and talk naturally and warmly, like a creator explaining something to a friend; their lip movements match their words exactly.',
    ACTOR_LINE_ONCE,
    scene && `Context: ${scene}.`,
    camera && `Camera: ${camera}.`,
    'Audio: only their voice and quiet room tone, no music. No subtitles, captions, on-screen text, logos or watermarks.',
  ]
    .filter(Boolean)
    .join(' ');
}

type PresenterPortraitDb = Pick<PrismaClient, 'videoProject' | '$executeRaw'>;

/** The portrait state at metadata.presenter.actorImage (the same states as UGC, portrait.ts). */
export function presenterActorImageOf(metadata: Prisma.JsonValue | null | undefined): {
  raw: Prisma.JsonValue | null;
  state: ReturnType<typeof parseActorImageState>;
} {
  const presenter =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, Prisma.JsonValue>)[PRESENTER_KEY]
      : undefined;
  const raw =
    presenter && typeof presenter === 'object' && !Array.isArray(presenter)
      ? ((presenter as Record<string, Prisma.JsonValue>).actorImage ?? null)
      : null;
  return { raw, state: parseActorImageState(raw) };
}

/** metadata.presenter.actorImage on studio.video_projects, changed atomically (compare-and-set). */
export function prismaPresenterPortraitStore(
  db: PresenterPortraitDb,
  organisationId: string,
): PortraitStore {
  return {
    async read(projectId) {
      const project = await db.videoProject.findFirst({
        where: { id: projectId, organisationId },
        select: { metadata: true },
      });
      return project ? presenterActorImageOf(project.metadata) : null;
    },
    async compareAndSet(projectId, expected, next) {
      const before = expected === null ? null : JSON.stringify(expected);
      const count =
        next === null
          ? await db.$executeRaw`
              UPDATE "studio"."video_projects"
              SET "metadata" = "metadata" #- '{presenter,actorImage}', "updatedAt" = now()
              WHERE "id" = ${projectId} AND "organisationId" = ${organisationId}
                AND ("metadata"->'presenter'->'actorImage') IS NOT DISTINCT FROM ${before}::jsonb`
          : await db.$executeRaw`
              UPDATE "studio"."video_projects"
              SET "metadata" = jsonb_set(
                    jsonb_set(
                      COALESCE("metadata", '{}'::jsonb),
                      '{presenter}',
                      COALESCE("metadata"->'presenter', '{}'::jsonb),
                      true
                    ),
                    '{presenter,actorImage}',
                    ${JSON.stringify(next)}::jsonb,
                    true
                  ),
                  "updatedAt" = now()
              WHERE "id" = ${projectId} AND "organisationId" = ${organisationId}
                AND jsonb_typeof(COALESCE("metadata", '{}'::jsonb)) = 'object'
                AND ("metadata"->'presenter'->'actorImage') IS NOT DISTINCT FROM ${before}::jsonb`;
      return count === 1;
    },
  };
}
