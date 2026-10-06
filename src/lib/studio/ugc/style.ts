import type { Prisma } from '@prisma/client';
import { z } from 'zod';

// BACKLOG 21.4 — the "UGC actor" video style (operator request 2026-10-04: "videos that are
// actually actors: UGC-style videos where actors talk about products"). A generated person (never
// a real one) speaks to camera about the business's product, selfie / handheld, with the
// provider's own audio as the narration (plans/phase-21-ugc.md).
//
// The style is stored on the project as metadata.ugc (no new column): the owner's optional product
// (a name and/or an image from the business's image library) and actor look (age range, gender
// presentation, setting, from small preset lists), plus a per-project seed. The seed picks the
// details the owner left open and the actor's hair and clothes, so every clip of the video
// describes the SAME person, and it is sent to providers that take a seed (Veo).

export const UGC_STYLE = 'UGC_ACTOR' as const;

export const UGC_AGE_RANGES = ['18-24', '25-34', '35-44', '45-60'] as const;
export const UGC_GENDERS = ['woman', 'man'] as const;
export const UGC_SETTINGS = [
  'kitchen',
  'living_room',
  'car',
  'outdoors',
  'bathroom',
  'desk',
  'shop',
] as const;

export type UgcAgeRange = (typeof UGC_AGE_RANGES)[number];
export type UgcGender = (typeof UGC_GENDERS)[number];
export type UgcSetting = (typeof UGC_SETTINGS)[number];

/** The longest UGC video: actor clips are short-form only (spec "15–30 s", 60 s ceiling). */
export const UGC_MAX_DURATION_SEC = 60;
/**
 * Veo documents English as "fully supported" and other languages as "have not been evaluated"
 * (https://ai.google.dev/gemini-api/docs/veo, read 2026-10-04), so actors speak English only
 * until the operator has checked other languages.
 */
export const UGC_LANGUAGES = ['en-GB', 'en-US'] as const;

export function isUgcLanguage(language: string | null | undefined): boolean {
  return (UGC_LANGUAGES as readonly string[]).includes(language ?? 'en-GB');
}

/** The POST /projects `ugc` body (and the Create screen's choice). Everything is optional. */
export const ugcInput = z
  .object({
    product: z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        /** An image_library row of the project's business (validated by the service). */
        imageId: z.string().trim().min(1).max(64).optional(),
      })
      .strict()
      .optional(),
    actor: z
      .object({
        ageRange: z.enum(UGC_AGE_RANGES).optional(),
        gender: z.enum(UGC_GENDERS).optional(),
        setting: z.enum(UGC_SETTINGS).optional(),
      })
      .strict()
      .optional(),
    /**
     * 22.3: a READY creator of the project's business (validated by the service). Its look and
     * portrait replace the actor choices above; absent = a new one-off actor (21.4).
     */
    creatorId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export type UgcInput = z.infer<typeof ugcInput>;

/** 22.3: the reusable creator a UGC project uses (metadata.ugc.creator). */
export interface UgcCreatorRef {
  id: string;
  /** The portrait the project was made with (creator_portraits.id): pinned for every clip. */
  portraitId: string;
  /** The creator's fixed look text (creators.description). */
  description: string;
  voiceTone: string | null;
}

export interface UgcStyle {
  style: typeof UGC_STYLE;
  product: { name: string | null; imageId: string | null };
  actor: { ageRange: UgcAgeRange; gender: UgcGender; setting: UgcSetting };
  /** 0 … 2^31-1; fixed for the project. */
  seed: number;
  /** 22.3: present when the project uses a reusable creator. */
  creator?: UgcCreatorRef;
}

/** 22.3: what newUgcStyle needs from a chosen creator. */
export interface UgcCreatorChoice extends UgcCreatorRef {
  ageRange: UgcAgeRange;
  gender: UgcGender;
  setting: UgcSetting;
}

/** A Veo seed is an unsigned 32-bit integer; we stay inside the signed range for every provider. */
export const MAX_UGC_SEED = 2 ** 31 - 1;

function pick<T>(list: readonly T[], seed: number, salt: number): T {
  const hash = (Math.imul(seed, 2654435761) ^ Math.imul(salt + 1, 40503)) >>> 0;
  return list[hash % list.length] as T;
}

/**
 * The stored style for a new project: the owner's choices, the rest picked from the seed. 22.3:
 * with a creator, the creator's age, gender and setting (and its look text) are the actor's.
 */
export function newUgcStyle(input: UgcInput, seed: number, creator?: UgcCreatorChoice): UgcStyle {
  const s = Math.max(0, Math.min(MAX_UGC_SEED, Math.floor(seed)));
  return {
    style: UGC_STYLE,
    product: { name: input.product?.name ?? null, imageId: input.product?.imageId ?? null },
    actor: creator
      ? { ageRange: creator.ageRange, gender: creator.gender, setting: creator.setting }
      : {
          ageRange: input.actor?.ageRange ?? pick(['25-34', '35-44'] as const, s, 1),
          gender: input.actor?.gender ?? pick(UGC_GENDERS, s, 2),
          setting: input.actor?.setting ?? pick(['kitchen', 'living_room', 'desk'] as const, s, 3),
        },
    seed: s,
    ...(creator && {
      creator: {
        id: creator.id,
        portraitId: creator.portraitId,
        description: creator.description,
        voiceTone: creator.voiceTone,
      },
    }),
  };
}

const ugcStored = z.object({
  style: z.literal(UGC_STYLE),
  product: z.object({ name: z.string().nullable(), imageId: z.string().nullable() }),
  actor: z.object({
    ageRange: z.enum(UGC_AGE_RANGES),
    gender: z.enum(UGC_GENDERS),
    setting: z.enum(UGC_SETTINGS),
  }),
  seed: z.number().int().min(0).max(MAX_UGC_SEED),
  creator: z
    .object({
      id: z.string().min(1),
      portraitId: z.string().min(1),
      description: z.string().min(1),
      voiceTone: z.string().nullable(),
    })
    .optional(),
});

/** metadata.ugc of a project, or null for every other video. */
export function ugcStyleOf(metadata: Prisma.JsonValue | null | undefined): UgcStyle | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const parsed = ugcStored.safeParse((metadata as Record<string, unknown>).ugc);
  return parsed.success ? parsed.data : null;
}

// ------------------------------------------------------------------ the actor's look

const AGE_TEXT: Readonly<Record<UgcAgeRange, string>> = {
  '18-24': 'in their early twenties',
  '25-34': 'around thirty',
  '35-44': 'around forty',
  '45-60': 'in their fifties',
};

const PERSON: Readonly<Record<UgcGender, string>> = { woman: 'woman', man: 'man' };

const HAIR = [
  'short dark curly hair',
  'shoulder-length straight brown hair',
  'wavy auburn hair tied back',
  'cropped black hair',
  'long blonde hair in a loose ponytail',
  'short grey-flecked hair',
] as const;

const CLOTHES = [
  'a mustard knit jumper',
  'a plain navy T-shirt',
  'a light denim shirt',
  'a soft green hoodie',
  'a cream cable-knit cardigan',
  'a simple black crew-neck top',
] as const;

export const SETTING_TEXT: Readonly<Record<UgcSetting, string>> = {
  kitchen: 'a bright, lived-in home kitchen',
  living_room: 'a cosy living room with a sofa and plants',
  car: 'the driver seat of a parked car, daylight through the windows',
  outdoors: 'a quiet street outside on a bright day',
  bathroom: 'a clean, softly lit bathroom by the mirror',
  desk: 'a tidy home-office desk by a window',
  shop: 'a small independent shop counter',
};

/**
 * One fixed description of the actor, repeated word for word in every clip prompt: the same age,
 * person, hair and clothes, so each clip describes the same generated person. Synthetic only.
 */
export function actorDescription(style: UgcStyle): string {
  // 22.3: a reusable creator's own look text (and how they speak), the same in every video.
  if (style.creator) {
    const voice = style.creator.voiceTone ? `, speaking in a ${style.creator.voiceTone} way` : '';
    return `${style.creator.description}${voice}`;
  }
  const person = PERSON[style.actor.gender];
  return `a ${person} ${AGE_TEXT[style.actor.ageRange]} with ${pick(HAIR, style.seed, 4)}, wearing ${pick(CLOTHES, style.seed, 5)}`;
}

/**
 * 22.3: a creator's fixed look text, from the presets and the owner's look notes (or, with no
 * notes, hair and clothes picked from the seed like a one-off actor). Synthetic people only: the
 * notes are real-person checked before they get here.
 */
export function creatorDescription(input: {
  gender: UgcGender;
  ageRange: UgcAgeRange;
  appearance: string | null;
  seed: number;
}): string {
  const base = `a ${PERSON[input.gender]} ${AGE_TEXT[input.ageRange]}`;
  const notes = input.appearance
    ?.trim()
    .replace(/\s+/g, ' ')
    .replace(/[.;,]+$/, '');
  if (notes) return `${base}, ${notes}`;
  return `${base} with ${pick(HAIR, input.seed, 4)}, wearing ${pick(CLOTHES, input.seed, 5)}`;
}
