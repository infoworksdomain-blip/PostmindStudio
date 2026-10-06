// BACKLOG 21.4 / 21.4c — the spoken line of a UGC actor clip, in the prompt text every actor
// adapter sends (Veo: docs/veo prompt guide "Use quotes for specific speech"; Kling documents no
// dialogue syntax, quoting is the common convention).
//
// 21.4c (production 2026-10-06, UGC QA video 3): Veo 3.1 Fast burned its own misspelt subtitles
// into an actor clip, under our captions. The scene prompt (ugc/prompt.ts actorClipPrompt) already
// said "No subtitles, captions, on-screen text…", but the quoted line was appended AFTER it, so the
// last thing the model read was the speech. The no-text instruction now comes last. Veo 3.1 lists
// no negativePrompt parameter (https://ai.google.dev/gemini-api/docs/veo, read 2026-10-06) and
// Kling's current API has no negative_prompt (kling.ts header), so it stays prompt text only.

/** The final sentence of every actor clip prompt, after the spoken line. */
export const NO_ON_SCREEN_TEXT =
  'Do not show any subtitles, captions, written words or on-screen text anywhere in the video.';

/**
 * The scene prompt, then the spoken line in quotes (double quotes inside the line would close the
 * quote early, so they become single quotes), then the no-text instruction.
 */
export function withDialogue(prompt: string, spokenLine: string): string {
  const line = spokenLine.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  return `${prompt.trim()}\nThe person speaks directly to the camera and says: "${line}"\n${NO_ON_SCREEN_TEXT}`;
}
