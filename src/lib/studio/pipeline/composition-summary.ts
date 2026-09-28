import { z } from 'zod';

// BACKLOG 15.B2 / 15.B6 — what Layer 6 put on the timeline, stored on video_renders.composition.
// The quality gate's EDL-level checks (audio_sync, caption_sync, watermark, brand_kit) and the
// composition cache (edlHash) read it, so they judge the edit that was actually rendered.

const rect = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const compositionSummarySchema = z.object({
  version: z.literal(1),
  edlHash: z.string().optional(),
  frame: z.object({ width: z.number(), height: z.number() }),
  totalSec: z.number(),
  introSec: z.number(),
  outroSec: z.number(),
  shots: z.array(
    z.object({
      shotId: z.string().nullable(),
      startSec: z.number(),
      lengthSec: z.number(),
      treatment: z.string(),
      /** Length of the narration clip laid on the timeline (null = no narration). */
      voiceClipSec: z.number().nullable(),
    }),
  ),
  brand: z.object({
    logo: z.boolean(),
    watermark: z
      .object({
        rect,
        opacity: z.number(),
        startSec: z.number(),
        endSec: z.number(),
      })
      .nullable(),
    intro: z.boolean(),
    outro: z.boolean(),
    /** P6 on-video AI label. */
    aiLabel: z.boolean(),
    /** P2 platform end card (never on white-label outputs). */
    platformCard: z.boolean(),
    fontFamily: z.string(),
    fontSources: z.array(z.string()),
    textColour: z.string(),
    backgroundColour: z.string(),
  }),
});

export type CompositionSummary = z.infer<typeof compositionSummarySchema>;

/** Parse a stored summary (untrusted JSON); null when absent or from an older build. */
export function parseCompositionSummary(value: unknown): CompositionSummary | null {
  const parsed = compositionSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
