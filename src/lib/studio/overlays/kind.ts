// BACKLOG 20.22 — what a text_overlays row is for (text_overlays.kind). Only narration captions
// mirror the voice-over, so only they are held to the §13.1 caption_sync check ("Captions align
// to voiceover ±200 ms"). Headlines, titles, CTAs, hooks and text-card words are on-screen text
// that is expected to differ from what is said (QA run 3: "Meeting panic mode" failed the check
// as "words not found in the narration").
//   - 'caption': a burned-in narration caption written by overlays/voice-captions.ts;
//   - 'on_screen': everything else (the default; suggested and user-added overlays).

export const OVERLAY_KINDS = ['on_screen', 'caption'] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];

export const CAPTION_KIND: OverlayKind = 'caption';
export const ON_SCREEN_KIND: OverlayKind = 'on_screen';

/** Karaoke highlighting follows the spoken words by design, whatever the row's kind. */
export const KARAOKE_ANIMATION = 'karaokeHighlight';

/**
 * True for overlays that are meant to mirror the narration: narration captions and karaoke
 * overlays. Never headline/title/CTA/text-card text, however many of its words are spoken.
 */
export function mirrorsNarration(row: { kind: string; animationIn: string }): boolean {
  return row.kind === CAPTION_KIND || row.animationIn === KARAOKE_ANIMATION;
}
