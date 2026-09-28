import { z } from 'zod';
import type { AspectRatio } from '../providers/interface';
import type { PlanTier } from '../providers/router';

// BACKLOG 15.B7 — per-format render presets (spec 5.8: "Each target format has its own render
// preset: aspect ratio, resolution, bitrate, frame rate"; spec 3.1: "720p for draft previews; 4K
// for YouTube long-form (Plus tier+)"). Only documented Shotstack Output fields are used
// (https://shotstack.io/docs/api/#tocs_output, read 2026-09-28):
//   - resolution: preview | mobile | sd | hd (1280x720) | 1080 | 4k (3840x2160);
//   - scaleTo: "the asset should be edited at the resolution dimensions … then use scaleTo to
//     output the file" at hd/sd/…, so a 720p draft keeps the 1080 layout and is scaled down;
//   - fps: 12, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60;
//   - quality: verylow | low | medium | high | veryhigh. Shotstack exposes no bitrate field, so
//     the "bitrate" part of a preset is expressed through `quality` (DOCUMENTED DEVIATION).
// Overlay previews keep their own `preview` resolution (overlays/preview.ts).

export type OutputResolution = 'hd' | '1080' | '4k';
export type OutputQuality = 'medium' | 'high';
// Draft previews and feed outputs use `medium` (Shotstack's default, "optimized quality, render
// speeds and file size"); full-screen short-form and YouTube use `high`.
export const ALLOWED_FPS = [24, 30, 60] as const;
export type Fps = (typeof ALLOWED_FPS)[number];

export interface RenderPreset {
  /** The resolution the edit is laid out at (pixel sizes in the EDL follow it). */
  resolution: OutputResolution;
  /** 720p drafts: laid out at 1080, scaled down by Shotstack. */
  scaleTo?: 'hd';
  fps: Fps;
  quality: OutputQuality;
}

/**
 * Defaults per target platform (services/catalog.ts PLATFORMS). Every destination takes 1080p;
 * fps 30 unless the owner picks 24/30/60. Feed placements (LinkedIn, X, feed video) are usually
 * re-encoded by the platform, so they render at `medium` quality (smaller uploads).
 */
export const PLATFORM_PRESETS: Readonly<Record<string, Omit<RenderPreset, 'scaleTo'>>> = {
  tiktok: { resolution: '1080', fps: 30, quality: 'high' },
  instagram_reel: { resolution: '1080', fps: 30, quality: 'high' },
  youtube_short: { resolution: '1080', fps: 30, quality: 'high' },
  youtube: { resolution: '1080', fps: 30, quality: 'high' },
  facebook: { resolution: '1080', fps: 30, quality: 'high' },
  linkedin_video: { resolution: '1080', fps: 30, quality: 'medium' },
  x: { resolution: '1080', fps: 30, quality: 'medium' },
  instagram_feed: { resolution: '1080', fps: 30, quality: 'medium' },
  facebook_feed: { resolution: '1080', fps: 30, quality: 'medium' },
};
const DEFAULT_PRESET: Omit<RenderPreset, 'scaleTo'> = {
  resolution: '1080',
  fps: 30,
  quality: 'high',
};

/** Spec 3.1: 4K is for YouTube long-form, Plus tier and above. */
export const FOUR_K_PLATFORMS = new Set(['youtube']);
export const FOUR_K_TIERS: ReadonlySet<PlanTier> = new Set<PlanTier>(['PLUS', 'ENTERPRISE']);

export const renderOptionsInput = z
  .object({
    fps: z
      .number()
      .int()
      .refine((v): v is Fps => (ALLOWED_FPS as readonly number[]).includes(v), {
        message: 'fps must be 24, 30 or 60',
      })
      .nullable()
      .optional(),
    youtubeResolution: z.enum(['1080', '4k']).nullable().optional(),
    /** Spec 3.1 draft previews: every output at 720p until switched off. */
    draft: z.boolean().optional(),
  })
  .strict();

export type RenderOptions = z.infer<typeof renderOptionsInput>;

/** Stored options from untrusted JSON (video_projects.renderOptions); invalid parts are ignored. */
export function parseRenderOptions(value: unknown): RenderOptions {
  const parsed = renderOptionsInput.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

export function fourKAllowed(platform: string, tier: PlanTier): boolean {
  return FOUR_K_PLATFORMS.has(platform) && FOUR_K_TIERS.has(tier);
}

/**
 * The preset for one output. A 4K request that the platform or tier no longer allows (e.g. a
 * downgrade after it was saved) falls back to 1080 rather than failing the render.
 */
export function resolvePreset(input: {
  platform: string;
  planTier: PlanTier;
  options: RenderOptions;
}): RenderPreset {
  const base = PLATFORM_PRESETS[input.platform] ?? DEFAULT_PRESET;
  const fps = input.options.fps ?? base.fps;
  if (input.options.draft) {
    return { resolution: '1080', scaleTo: 'hd', fps, quality: 'medium' };
  }
  const wants4k =
    input.options.youtubeResolution === '4k' && fourKAllowed(input.platform, input.planTier);
  return { resolution: wants4k ? '4k' : base.resolution, fps, quality: base.quality };
}

/** Pixel size of the layout per aspect ratio (short side 1080, or 2160 for 4K). */
export function outputDimensions(
  aspectRatio: AspectRatio,
  resolution: OutputResolution = '1080',
): { width: number; height: number } {
  const k = resolution === '4k' ? 2 : 1; // hd drafts keep the 1080 layout (scaleTo)
  switch (aspectRatio) {
    case '9:16':
      return { width: 1080 * k, height: 1920 * k };
    case '16:9':
      return { width: 1920 * k, height: 1080 * k };
    case '1:1':
      return { width: 1080 * k, height: 1080 * k };
    case '4:5':
      return { width: 1080 * k, height: 1350 * k };
  }
}

/** The Shotstack `output` object for a preset. */
export function presetOutput(aspectRatio: AspectRatio, preset: RenderPreset) {
  return {
    format: 'mp4',
    resolution: preset.resolution,
    ...(preset.scaleTo && { scaleTo: preset.scaleTo }),
    aspectRatio,
    fps: preset.fps,
    quality: preset.quality,
  };
}

/** Apply a preset to an already-built edit (slideshow and shot edits alike). */
export function withPreset(
  edit: Record<string, unknown>,
  aspectRatio: AspectRatio,
  preset: RenderPreset,
): Record<string, unknown> {
  return { ...edit, output: presetOutput(aspectRatio, preset) };
}
