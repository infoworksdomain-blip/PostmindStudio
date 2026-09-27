// Phase 13.7 — per-platform safe-area guides for the overlay frame: the part of the frame not
// covered by the platform's own interface (captions, buttons, profile), as fractions of the frame.
//
// Sources (read 2026-09-27):
//  * Instagram Reels and Facebook Reels — OFFICIAL. Meta's Ads Guide: "leave roughly 14% of the
//    top, 35% of the bottom, and 6% on each side … free from text, logos, or other key creative
//    elements" (https://www.facebook.com/business/ads-guide/update/video/instagram-reels).
//  * TikTok — NO published numbers. TikTok documents that the safe zone depends on the caption
//    length and add-ons and only offers downloadable safe-zone files and a preview tool
//    (https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads). A CONSERVATIVE margin is
//    used: Meta's top/bottom, plus a wider right edge for TikTok's button column.
//  * YouTube Shorts, YouTube, LinkedIn, X — no official numeric safe zone found for organic
//    video. CONSERVATIVE margins: the Shorts value mirrors TikTok's; landscape/square formats use
//    a 5% title-safe inset.
// Guides are advisory: nothing blocks placing text outside them.

export interface SafeArea {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** Shown next to the guide so nobody mistakes a conservative margin for a platform rule. */
  label: string;
  official: boolean;
}

const META_REELS = { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 };
const VERTICAL_CONSERVATIVE = { top: 0.14, bottom: 0.35, left: 0.06, right: 0.15 };
const TITLE_SAFE = { top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 };

export const SAFE_AREAS: Record<string, SafeArea> = {
  instagram_reel: { ...META_REELS, label: 'Instagram Reels safe zone (Meta)', official: true },
  facebook: { ...META_REELS, label: 'Facebook Reels safe zone (Meta)', official: true },
  tiktok: {
    ...VERTICAL_CONSERVATIVE,
    label: 'TikTok — conservative margin (TikTok publishes no fixed numbers)',
    official: false,
  },
  youtube_short: {
    ...VERTICAL_CONSERVATIVE,
    label: 'YouTube Shorts — conservative margin (no official numbers)',
    official: false,
  },
  youtube: { ...TITLE_SAFE, label: 'YouTube — 5% title-safe (conservative)', official: false },
  linkedin_video: {
    ...TITLE_SAFE,
    label: 'LinkedIn — 5% title-safe (conservative)',
    official: false,
  },
  x: { ...TITLE_SAFE, label: 'X — 5% title-safe (conservative)', official: false },
};

/** The safe area for a platform; landscape formats never use the vertical feed margins. */
export function safeAreaFor(platform: string, aspectRatio: string): SafeArea | null {
  const area = SAFE_AREAS[platform];
  if (!area) return null;
  if (aspectRatio === '16:9' && area.bottom > 0.2)
    return {
      ...TITLE_SAFE,
      label: `${area.label.split(' —')[0]} — 5% title-safe (conservative)`,
      official: false,
    };
  return area;
}

/** True when an anchor point (0–1) sits inside the safe area. */
export function insideSafeArea(area: SafeArea, anchorX: number, anchorY: number): boolean {
  return (
    anchorX >= area.left &&
    anchorX <= 1 - area.right &&
    anchorY >= area.top &&
    anchorY <= 1 - area.bottom
  );
}
