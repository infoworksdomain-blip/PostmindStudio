// 15.C8 — platform-native Layer 2 guidance (spec 5.3 and 5.8).
//   5.3: "The model must not exceed the platform's optimal duration curve — 21-34s for TikTok /
//        Reels engagement peak, 45-60s for YouTube Shorts, 4-8 min for YouTube long-form."
//        "A single script may fan out into 5+ output formats with the same shot logic but
//        different pacing, captions, and hook framing."
//   5.8: "the first 1.5s of a TikTok is framed differently from the first 1.5s of an Instagram
//        Reel"; "TikTok gets platform-native-style captions; Reels get burned-in captions …;
//        YouTube gets uploaded as SRT alongside the video."
// The guidance is craft direction for the model (hook framing, pacing, caption style). It never
// changes the target duration the user chose: the curve is stated so the model paces within it.

export interface PlatformGuidance {
  /** Spec 5.3 optimal duration curve, seconds [min, max]; null where the spec gives none. */
  optimalSec: [number, number] | null;
  hook: string;
  pacing: string;
  captions: string;
}

const SHORT_VERTICAL_PACING =
  'Fast pacing: a new visual every 1.5–3 seconds, no slow build-up, the payoff before the end.';

export const PLATFORM_GUIDANCE: Readonly<Record<string, PlatformGuidance>> = {
  tiktok: {
    optimalSec: [21, 34],
    hook: 'First 1.5 seconds: open mid-action or with a spoken pattern-interrupt line to camera; the hook is said aloud AND shown as on-screen text, with no logo or intro card.',
    pacing: SHORT_VERTICAL_PACING,
    captions:
      'On-screen text is short, native-style caption lines (a few words each) placed as TikTok creators do.',
  },
  instagram_reel: {
    optimalSec: [21, 34],
    hook: 'First 1.5 seconds: lead with the most striking visual of the video (a polished, aesthetic frame) plus a short bold text hook; the image must hold attention even with the sound off.',
    pacing: SHORT_VERTICAL_PACING,
    captions:
      'Captions are burned into the video (Meta strips soft captions), so every spoken line needs matching on-screen text.',
  },
  facebook: {
    optimalSec: [21, 34],
    hook: 'First 1.5 seconds: a clear visual subject and a text hook readable without sound (most feed viewing is muted).',
    pacing: SHORT_VERTICAL_PACING,
    captions: 'Captions are burned in: every spoken line needs matching on-screen text.',
  },
  youtube_short: {
    optimalSec: [45, 60],
    hook: 'First 1.5 seconds: state the promise of the video (what the viewer will get) in one spoken line; give a reason to watch to the end, which suits a loop back to the start.',
    pacing:
      'Steady pacing across 45–60 seconds: hook, three quick beats of value, then the call to action.',
    captions: 'Short on-screen text for key words only; full captions are handled separately.',
  },
  youtube: {
    optimalSec: [240, 480],
    hook: 'First 5 seconds: say what the video covers and why it matters to the viewer; no long intro.',
    pacing: 'Structured pacing: clear sections with a one-line summary before moving on.',
    captions:
      'On-screen text only for section titles and key facts; spoken captions are uploaded as an SRT file.',
  },
  linkedin_video: {
    optimalSec: null,
    hook: 'First 1.5 seconds: a professional, specific statement or result shown as text (most viewers watch muted).',
    pacing: 'Measured pacing, one business point per shot.',
    captions: 'Every spoken line needs matching on-screen text for muted viewing.',
  },
  x: {
    optimalSec: null,
    hook: 'First 1.5 seconds: a bold statement as on-screen text; no intro.',
    pacing: 'Tight, fast pacing.',
    captions: 'Every spoken line needs matching on-screen text for muted viewing.',
  },
};

function describeCurve([min, max]: [number, number]): string {
  return max >= 120 ? `${min / 60}–${max / 60} minutes` : `${min}–${max} seconds`;
}

/** The guidance block appended to the Layer 2 prompt for one target format. */
export function platformGuidanceBlock(platform: string, targetSec: number): string {
  const guidance = PLATFORM_GUIDANCE[platform];
  if (!guidance) return '';
  const lines = [`Platform guidance (${platform}):`];
  lines.push(`- Hook framing: ${guidance.hook}`);
  lines.push(`- Pacing: ${guidance.pacing}`);
  lines.push(`- Caption style: ${guidance.captions}`);
  if (guidance.optimalSec) {
    const [min, max] = guidance.optimalSec;
    const within = targetSec >= min && targetSec <= max;
    lines.push(
      `- Engagement peak for this platform is ${describeCurve(guidance.optimalSec)}; ${
        within
          ? 'this video is inside it.'
          : `this video is ${targetSec}s by the owner's choice, so pace it tightly and keep the strongest material early.`
      }`,
    );
  }
  return lines.join('\n');
}
