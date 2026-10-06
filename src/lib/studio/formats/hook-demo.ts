import type { Prisma } from '@prisma/client';
import { z } from 'zod';

// BACKLOG 22.1 — "Hook + demo" (operator request 2026-10-05: "Review how Fastlane generates their
// videos and replicate the video generation process"). Fastlane's main format, from its public
// developer docs (https://developers.usefastlane.ai/#endpoints, read 2026-10-05) and founder
// demos: a short reaction hook clip (a person's surprised / curious look, 1–3 s) carrying ONE
// on-screen hook line, then immediately the business's OWN demo video (a screen recording or
// phone-in-hand footage), with a music bed balanced against the demo's own audio. The demo is
// always uploaded by the business (never generated), and there is no video without one
// (Fastlane answers `no_demo_video`; Studio answers the same code, errors.ts NoDemoVideoError).
//
// The project keeps its choices in metadata.hookDemo (validated here, like metadata.carousel).
// Studio-specific decisions (2026-10-05):
//   - sequential is the default layout (hook, then the demo full frame); "stacked" puts the hook
//     in the top half over the demo's first seconds in the bottom half, then the demo full frame;
//   - the hook clip is silent (its audio is muted in the edit); the music bed and the demo's own
//     audio are the soundtrack, balanced by `audioMix`;
//   - the hook is 3 s (inside the 1.5–4 s window); the demo is trimmed to fill a 10–20 s video.

export const HOOK_SOURCES = ['ai_creator', 'library'] as const;
export type HookSource = (typeof HOOK_SOURCES)[number];
export const HOOK_REACTIONS = ['surprised', 'curious', 'wait_what'] as const;
export type HookReaction = (typeof HOOK_REACTIONS)[number];
export const HOOK_LAYOUTS = ['sequential', 'stacked'] as const;
export type HookLayout = (typeof HOOK_LAYOUTS)[number];
export const AUDIO_MIXES = ['demo', 'balanced', 'music'] as const;
export type AudioMix = (typeof AUDIO_MIXES)[number];

export const HOOK_MIN_SEC = 1.5;
export const HOOK_MAX_SEC = 4;
export const HOOK_DEFAULT_SEC = 3;
/** The generated reaction clip (Veo renders 4, 6 or 8 s; the edit trims it to the hook). */
export const HOOK_CLIP_SEC = 4;
export const TARGET_MIN_SEC = 10;
export const TARGET_MAX_SEC = 20;
export const TARGET_DEFAULT_SEC = 15;
/** A demo shorter than this cannot follow a hook meaningfully. */
export const DEMO_MIN_SEC = 2;
/**
 * 22.6 (production QA 2026-10-06): 12 words at the old hook size wrapped to five lines over the
 * creator's face; 9 words at 4.2 % (caption-style.ts) stays on one or two lines.
 */
export const HOOK_LINE_MAX_WORDS = 9;
export const HOOK_LINE_MAX_CHARS = 80;

/** 22.1: a hook + demo video counts as one video of the allowance (allowanceUnitsOf → 1). */
export const HOOK_DEMO_ALLOWANCE_UNITS = 1;

const EMOJI = /\p{Extended_Pictographic}/u;

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** The owner's hook line: one line, at most HOOK_LINE_MAX_WORDS words, no emoji. */
export const hookLineInput = z
  .string()
  .trim()
  .min(1)
  .max(HOOK_LINE_MAX_CHARS)
  .refine((v) => !/[\r\n]/.test(v), { message: 'The hook line must be one line' })
  .refine((v) => wordCount(v) <= HOOK_LINE_MAX_WORDS, {
    message: `The hook line can have at most ${HOOK_LINE_MAX_WORDS} words`,
  })
  .refine((v) => !EMOJI.test(v), { message: 'The hook line cannot contain emoji' });

/** POST /projects { sourceType: HOOK_DEMO, hookDemo } (services/projects.ts). */
export const hookDemoCreateInput = z
  .object({
    /** A READY demo video of the business (POST /uploads kind demo_video). Omitted = the newest. */
    demoUploadId: z.string().trim().min(1).max(64).optional(),
    /** Omitted = Claude writes it from the brief and the brand profile (hook-line.ts). */
    hookLine: hookLineInput.optional(),
    hookSource: z.enum(HOOK_SOURCES).default('ai_creator'),
    reaction: z.enum(HOOK_REACTIONS).default('surprised'),
    layout: z.enum(HOOK_LAYOUTS).default('sequential'),
    audioMix: z.enum(AUDIO_MIXES).default('balanced'),
    targetSec: z.number().int().min(TARGET_MIN_SEC).max(TARGET_MAX_SEC).default(TARGET_DEFAULT_SEC),
    /**
     * 22.4 / 22.5: false for Blitz cards and automation slots, which are made before anyone
     * keeps them: the hook must come from the library, never from a paid generated clip.
     */
    allowGeneratedHook: z.boolean().default(true),
  })
  .strict();
export type HookDemoCreateInput = z.infer<typeof hookDemoCreateInput>;

/** metadata.hookDemo as stored. */
export const hookDemoDocument = z.object({
  demoUploadId: z.string(),
  demoAssetId: z.string(),
  hookLine: z.string().nullable(),
  hookSource: z.enum(HOOK_SOURCES),
  reaction: z.enum(HOOK_REACTIONS),
  layout: z.enum(HOOK_LAYOUTS),
  audioMix: z.enum(AUDIO_MIXES),
  targetSec: z.number().int().min(TARGET_MIN_SEC).max(TARGET_MAX_SEC),
  /** The line the last run put on screen (the owner's, or the one Claude wrote). */
  writtenHookLine: z.string().nullable().optional(),
  /** 22.4 / 22.5: false = library hook only (absent on older rows = allowed). */
  allowGeneratedHook: z.boolean().optional(),
});
export type HookDemoDocument = z.infer<typeof hookDemoDocument>;

export function readHookDemo(
  metadata: Prisma.JsonValue | null | undefined,
): HookDemoDocument | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const parsed = hookDemoDocument.safeParse((metadata as Record<string, unknown>).hookDemo);
  return parsed.success ? parsed.data : null;
}

export function newHookDemoDocument(
  input: HookDemoCreateInput,
  demo: { uploadId: string; assetId: string },
): HookDemoDocument {
  return {
    demoUploadId: demo.uploadId,
    demoAssetId: demo.assetId,
    hookLine: input.hookLine ?? null,
    hookSource: input.hookSource,
    reaction: input.reaction,
    layout: input.layout,
    audioMix: input.audioMix,
    targetSec: input.targetSec,
    writtenHookLine: null,
    allowGeneratedHook: input.allowGeneratedHook,
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface HookDemoTiming {
  hookSec: number;
  demoSec: number;
  totalSec: number;
}

/**
 * The hook's and the demo's lengths. The hook is 3 s (clamped to 1.5–4 s); the demo plays from its
 * start for the rest of the target (10–20 s), or its whole length when it is shorter. The total is
 * a whole number of seconds (scripts store a whole-second target for the duration check). In a
 * stacked layout the demo already plays under the hook, so the full-frame part starts `hookSec`
 * into the file and only the rest of the demo is available after the hook.
 */
export function hookDemoTiming(input: {
  targetSec: number;
  demoDurationSec: number;
  hookSec?: number;
  stacked?: boolean;
}): HookDemoTiming {
  const hookSec = round3(
    Math.min(HOOK_MAX_SEC, Math.max(HOOK_MIN_SEC, input.hookSec ?? HOOK_DEFAULT_SEC)),
  );
  const target = Math.min(TARGET_MAX_SEC, Math.max(TARGET_MIN_SEC, Math.round(input.targetSec)));
  const available = Math.max(0, input.demoDurationSec - (input.stacked ? hookSec : 0));
  const rawTotal = Math.min(target, hookSec + available);
  const totalSec = Math.max(Math.ceil(hookSec), Math.floor(rawTotal));
  return { hookSec, demoSec: round3(totalSec - hookSec), totalSec };
}

/** The demo's own audio level and the music bed's level for the chosen mix (Shotstack 0–1). */
export const AUDIO_MIX_LEVELS: Record<AudioMix, { demo: number; musicUnder: number }> = {
  // The demo's sound (a voice-over, app sounds) leads; music sits well under it (≈ −16 dB).
  demo: { demo: 1, musicUnder: 0.15 },
  balanced: { demo: 0.8, musicUnder: 0.3 },
  // Music leads; the demo's own audio is muted.
  music: { demo: 0, musicUnder: 0.7 },
};

/** A stacked layout needs a portrait frame (two halves); landscape and square stay sequential. */
export function effectiveLayout(layout: HookLayout, aspectRatio: string): HookLayout {
  return layout === 'stacked' && (aspectRatio === '9:16' || aspectRatio === '4:5')
    ? 'stacked'
    : 'sequential';
}
