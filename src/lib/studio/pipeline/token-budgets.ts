// Output token budgets for the planning calls (Layers 1–2). A leaf module with no imports, so the
// workers that share these constants (plan-project, regenerate-script) can import them without the
// circular-import temporal dead zone that a constant re-exported between those two workers hit
// (CI, 2026-10-04: "Cannot access 'MAX_PLANNING_OUTPUT_TOKENS' before initialization").

/**
 * The ideation output budget grows with the number of target platforms: since 20.13 ideation also
 * drafts a caption and hashtags per platform. A fixed 4 000 cut a nine-platform brief off mid-JSON
 * (production 2026-10-03, "output_truncated: Output hit max_tokens (4000)"). Capped at 16 000, the
 * default output limit of the OpenAI fallback (openai-text.ts).
 */
export const MAX_PLANNING_OUTPUT_TOKENS = 16_000;

export function ideationMaxTokens(platformCount: number): number {
  return Math.min(MAX_PLANNING_OUTPUT_TOKENS, 3_000 + 900 * Math.max(1, platformCount));
}

/**
 * One script per format and language, so the script budget does not grow with the format count.
 * 8 000 cut a 30 s TikTok script off mid-JSON after 70 s of generation (production QA run 11,
 * 2026-10-04, "output_truncated: Output hit max_tokens (8000)"); scripts now get the planning cap.
 */
export const SCRIPT_MAX_TOKENS = MAX_PLANNING_OUTPUT_TOKENS;
