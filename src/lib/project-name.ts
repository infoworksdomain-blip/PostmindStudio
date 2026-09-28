// BACKLOG 17.9 — "Untitled video" is never stored. A project the user did not name has
// `name = null`; the app shows the translated fallback (common.untitledVideo) and server-written
// English text (notification fallbacks, email, webhooks, logs) says "Untitled video". Rows
// created before Phase 17 stored the English words themselves: they count as untitled too.
// Pure module: used by the server and the UI.

/** The English fallback — for server-written English sentences only. */
export const UNTITLED_VIDEO_EN = 'Untitled video';

/** The user gave the project no name (null, blank, or the legacy stored English words). */
export function isUntitledName(name: string | null | undefined): boolean {
  const trimmed = name?.trim();
  return !trimmed || trimmed === UNTITLED_VIDEO_EN;
}

/** The name for an English sentence the server writes. */
export function projectLabel(name: string | null | undefined): string {
  return isUntitledName(name) ? UNTITLED_VIDEO_EN : (name as string).trim();
}

/**
 * The name as a message parameter (notifications.*): '' when untitled, which the UI replaces
 * with the translated "Untitled video" (notification-text.ts).
 */
export function projectNameParam(name: string | null | undefined): string {
  return isUntitledName(name) ? '' : (name as string).trim();
}

/** The name when the reader is a program that must not see a placeholder (e.g. a prompt). */
export function realProjectName(name: string | null | undefined): string | undefined {
  return isUntitledName(name) ? undefined : (name as string).trim();
}
