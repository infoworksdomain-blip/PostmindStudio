// The generic content-safety result (Layer 8, spec 13.2) a `content_safety` provider returns as
// its poll output metadata. 20.21 (operator decision 2026-10-02): Hive was removed and no
// content-safety provider is built, so today nothing returns this and the quality gate records
// the scan as skipped (pipeline/quality-checks.ts). A future provider maps its own labels onto
// the class names the policy in quality-checks.ts evaluates.

export interface ContentSafetyScan {
  framesAnalysed: number;
  /** Highest score per class across the scanned frames, each in [0, 1]. */
  maxScores: Record<string, number>;
  flaggedFrames: Array<{ time: number; class: string; score: number }>;
}
