// Shared by the Hive V2 and V3 clients: one scanned frame's class scores, and the per-class
// maxima the Layer 8 policy (pipeline/quality-checks.ts) evaluates. Hive states that V3 "returns
// the same class names and confidence scores as V2, so your threshold logic stays unchanged"
// (https://docs.thehive.ai/docs/visual-content-moderation, read 2026-09-30); only the JSON keys
// differ (V2 `class`/`score`, V3 `class_name`/`value`), and each client maps its own keys here.

export interface ScannedFrame {
  /** Seconds into the video (0 for a single image). */
  time: number;
  classes: ReadonlyArray<{ class: string; score: number }>;
}

export interface ContentSafetyScan {
  framesAnalysed: number;
  maxScores: Record<string, number>;
  flaggedFrames: Array<{ time: number; class: string; score: number }>;
}

const MAX_FLAGGED_FRAMES = 50;
/** Scores at or above this are listed as flagged frames (Hive suggests >0.90 as a start). */
const FLAG_REPORT_THRESHOLD = 0.5;

export function summariseFrames(frames: readonly ScannedFrame[]): ContentSafetyScan {
  const maxScores: Record<string, number> = {};
  const flagged: ContentSafetyScan['flaggedFrames'] = [];
  for (const frame of frames) {
    for (const c of frame.classes) {
      maxScores[c.class] = Math.max(maxScores[c.class] ?? 0, c.score);
      if (c.score >= FLAG_REPORT_THRESHOLD && !c.class.startsWith('no_')) {
        flagged.push({ time: frame.time, class: c.class, score: c.score });
      }
    }
  }
  flagged.sort((a, b) => b.score - a.score);
  return {
    framesAnalysed: frames.length,
    maxScores,
    flaggedFrames: flagged.slice(0, MAX_FLAGGED_FRAMES),
  };
}
