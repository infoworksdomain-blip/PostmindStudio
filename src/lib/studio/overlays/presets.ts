import type { PresetParameters } from './params';

// BACKLOG 8.2 / Addendum A4.3 — built-in overlay presets (25+), grouped by intent. Every preset
// is a partial style over DEFAULT_STYLE; brandSubstitution lets a brand kit recolour it.

export const PRESET_GROUPS = [
  'hook',
  'subtitle',
  'cta',
  'quote',
  'statistic',
  'story',
  'brand',
] as const;
export type PresetGroup = (typeof PRESET_GROUPS)[number];

export interface BuiltInPreset {
  key: string;
  name: string;
  group: PresetGroup;
  parameters: PresetParameters;
  brandSubstitution: boolean;
}

const hook = (key: string, name: string, parameters: PresetParameters): BuiltInPreset => ({
  key,
  name,
  group: 'hook',
  parameters: {
    fontSizePct: 7,
    fontWeight: 900,
    anchorY: 0.3,
    animationIn: 'popIn',
    ...parameters,
  },
  brandSubstitution: true,
});

/**
 * BACKLOG 21.4b — TikTok's classic caption look, as seen frame by frame in Fastlane's UGC showcase
 * videos (2026-10-05): white text with a thin black outline, NO background box, small (about
 * 3.5–4% of the frame height), placed where the face stays clear. Readability comes from the
 * stroke, so the brand kit never recolours it (brandSubstitution false: a brand secondary as the
 * fill with no box behind it could be unreadable). The stroke is 3 px like hook_bold_centre (the
 * presets' widths are in output pixels at the 1080-wide layout). Cuts in and out with no fade, the
 * way the platform's own captions change.
 */
const TIKTOK_CLASSIC: PresetParameters = {
  fontFamily: 'Montserrat',
  fontWeight: 800,
  fontSizePct: 3.6,
  lineHeight: 1.15,
  anchorY: 0.7,
  fillColor: '#FFFFFF',
  strokeColor: '#000000',
  strokeWidthPx: 3,
  shadowColor: null,
  backgroundType: 'none',
  backgroundColor: null,
  backgroundPaddingPx: null,
  backgroundRadiusPx: null,
  animationIn: 'none',
  animationOut: 'none',
};

export const BUILT_IN_PRESETS: BuiltInPreset[] = [
  // Hook — first 1–2 seconds
  hook('hook_bold_centre', 'Bold Centre', {
    fontFamily: 'Montserrat',
    strokeColor: '#000000',
    strokeWidthPx: 3,
  }),
  hook('hook_bold_left', 'Bold Left', {
    fontFamily: 'Montserrat',
    alignment: 'left',
    anchorX: 0.1,
    animationIn: 'slideInLeft',
  }),
  hook('hook_retro_yellow', 'Retro Yellow', {
    fontFamily: 'Bebas Neue',
    fillColor: '#FFD400',
    shadowColor: '#000000',
    shadowOffsetXPx: 4,
    shadowOffsetYPx: 4,
    shadowBlurPx: 0,
  }),
  hook('hook_ransom_note', 'Ransom Note', {
    fontFamily: 'Permanent Marker',
    backgroundType: 'box',
    backgroundColor: '#FFFFFF',
    fillColor: '#111111',
    rotationDeg: -3,
    backgroundPaddingPx: 12,
  }),
  hook('hook_tiktok_native', 'TikTok Native', {
    fontFamily: 'Montserrat',
    fontWeight: 700,
    fontSizePct: 5,
    backgroundType: 'rounded_box',
    backgroundColor: '#FFFFFF',
    fillColor: '#000000',
    backgroundPaddingPx: 14,
    backgroundRadiusPx: 12,
  }),
  // 21.4b: the opening hook of a UGC video, in the same box-less outlined look as its captions.
  {
    key: 'hook_tiktok_classic',
    name: 'TikTok Classic Hook',
    group: 'hook',
    parameters: { ...TIKTOK_CLASSIC, fontSizePct: 4.2, anchorY: 0.11, animationIn: 'fadeIn' },
    brandSubstitution: false,
  },
  // Subtitle — voiceover captioning
  {
    key: 'subtitle_tiktok_classic',
    name: 'TikTok Classic',
    group: 'subtitle',
    parameters: TIKTOK_CLASSIC,
    brandSubstitution: false,
  },
  {
    key: 'subtitle_clean_lower',
    name: 'Clean Lower',
    group: 'subtitle',
    parameters: {
      fontFamily: 'Inter',
      fontWeight: 600,
      fontSizePct: 3.6,
      anchorY: 0.78,
      animationIn: 'fadeIn',
      animationInMs: 150,
      animationOutMs: 150,
    },
    brandSubstitution: false,
  },
  {
    key: 'subtitle_karaoke',
    name: 'Karaoke Highlight',
    group: 'subtitle',
    parameters: {
      fontFamily: 'Montserrat',
      fontWeight: 800,
      fontSizePct: 4,
      anchorY: 0.72,
      animationIn: 'karaokeHighlight',
      strokeColor: '#000000',
      strokeWidthPx: 2,
    },
    brandSubstitution: true,
  },
  {
    key: 'subtitle_box',
    name: 'Box Background',
    group: 'subtitle',
    parameters: {
      fontFamily: 'Inter',
      fontSizePct: 3.4,
      anchorY: 0.78,
      backgroundType: 'box',
      backgroundColor: '#000000B3',
      backgroundPaddingPx: 10,
      shadowColor: null,
    },
    brandSubstitution: true,
  },
  {
    key: 'subtitle_duo_tone',
    name: 'Duo-Tone',
    group: 'subtitle',
    parameters: {
      fontFamily: 'Poppins',
      fontWeight: 700,
      fontSizePct: 3.8,
      anchorY: 0.75,
      fillColor: '#FFFFFF',
      strokeColor: '#FF3B6B',
      strokeWidthPx: 2,
    },
    brandSubstitution: true,
  },
  // Call to action — last shot
  {
    key: 'cta_big_arrow',
    name: 'Big Arrow',
    group: 'cta',
    parameters: {
      fontFamily: 'Anton',
      fontSizePct: 6,
      anchorY: 0.65,
      animationIn: 'slideInBottom',
      backgroundType: 'rounded_box',
      backgroundColor: '#FF3B30',
      backgroundPaddingPx: 18,
      backgroundRadiusPx: 40,
    },
    brandSubstitution: true,
  },
  {
    key: 'cta_pulse_button',
    name: 'Pulse Button',
    group: 'cta',
    parameters: {
      fontFamily: 'Poppins',
      fontWeight: 800,
      fontSizePct: 4.5,
      anchorY: 0.7,
      animationIn: 'scaleIn',
      backgroundType: 'rounded_box',
      backgroundColor: '#2563EB',
      backgroundPaddingPx: 20,
      backgroundRadiusPx: 999,
    },
    brandSubstitution: true,
  },
  {
    key: 'cta_ticker',
    name: 'Ticker Marquee',
    group: 'cta',
    parameters: {
      fontFamily: 'Roboto Mono',
      fontWeight: 700,
      fontSizePct: 3.5,
      anchorY: 0.9,
      animationIn: 'slideInRight',
      animationOut: 'slideOutLeft',
      backgroundType: 'box',
      backgroundColor: '#000000',
      backgroundPaddingPx: 8,
    },
    brandSubstitution: true,
  },
  {
    key: 'cta_hand_drawn',
    name: 'Hand-Drawn',
    group: 'cta',
    parameters: {
      fontFamily: 'Caveat',
      fontWeight: 700,
      fontSizePct: 6,
      anchorY: 0.7,
      rotationDeg: -4,
      animationIn: 'typewriter',
      effect: { typewriterCPS: 18 },
    },
    brandSubstitution: true,
  },
  // Quote
  {
    key: 'quote_serif',
    name: 'Serif Quote',
    group: 'quote',
    parameters: {
      fontFamily: 'Playfair Display',
      fontWeight: 600,
      fontItalic: true,
      fontSizePct: 4.5,
      lineHeight: 1.3,
      animationIn: 'fadeIn',
      animationInMs: 800,
    },
    brandSubstitution: true,
  },
  {
    key: 'quote_modern',
    name: 'Modern Quote',
    group: 'quote',
    parameters: {
      fontFamily: 'Poppins',
      fontWeight: 500,
      fontSizePct: 4.2,
      lineHeight: 1.35,
      animationIn: 'blurIn',
    },
    brandSubstitution: true,
  },
  {
    key: 'quote_author_byline',
    name: 'Author Byline',
    group: 'quote',
    parameters: {
      fontFamily: 'Inter',
      fontWeight: 400,
      fontSizePct: 2.6,
      anchorY: 0.68,
      letterSpacing: 2,
      animationIn: 'fadeIn',
      animationInMs: 600,
    },
    brandSubstitution: false,
  },
  {
    key: 'quote_split',
    name: 'Split Quote',
    group: 'quote',
    parameters: {
      fontFamily: 'Playfair Display',
      fontWeight: 700,
      fontSizePct: 5,
      alignment: 'left',
      anchorX: 0.12,
      animationIn: 'slideInLeft',
    },
    brandSubstitution: true,
  },
  // Statistic
  {
    key: 'stat_big_number',
    name: 'Big Number',
    group: 'statistic',
    parameters: {
      fontFamily: 'Anton',
      fontSizePct: 16,
      animationIn: 'scaleIn',
      shadowColor: '#00000099',
      shadowBlurPx: 12,
    },
    brandSubstitution: true,
  },
  {
    key: 'stat_ticker_roll',
    name: 'Ticker Roll-Up',
    group: 'statistic',
    parameters: {
      fontFamily: 'Roboto Mono',
      fontWeight: 700,
      fontSizePct: 12,
      animationIn: 'counter',
      effect: { counterFrom: 0 },
    },
    brandSubstitution: true,
  },
  {
    key: 'stat_percentage_ring',
    name: 'Percentage Ring',
    group: 'statistic',
    parameters: {
      fontFamily: 'Montserrat',
      fontWeight: 800,
      fontSizePct: 10,
      backgroundType: 'rounded_box',
      backgroundColor: '#FFFFFF26',
      backgroundRadiusPx: 999,
      backgroundPaddingPx: 40,
      animationIn: 'scaleIn',
    },
    brandSubstitution: true,
  },
  {
    key: 'stat_count_up',
    name: 'Count-Up',
    group: 'statistic',
    parameters: {
      fontFamily: 'Montserrat',
      fontWeight: 900,
      fontSizePct: 14,
      animationIn: 'counter',
      effect: { counterFrom: 0 },
    },
    brandSubstitution: true,
  },
  // Story
  {
    key: 'story_whatsapp_bubble',
    name: 'Whatsapp-Bubble',
    group: 'story',
    parameters: {
      fontFamily: 'Inter',
      fontWeight: 500,
      fontSizePct: 3.2,
      alignment: 'left',
      anchorX: 0.1,
      backgroundType: 'rounded_box',
      backgroundColor: '#DCF8C6',
      fillColor: '#111111',
      backgroundPaddingPx: 14,
      backgroundRadiusPx: 18,
      shadowColor: null,
      animationIn: 'popIn',
    },
    brandSubstitution: false,
  },
  {
    key: 'story_typewriter',
    name: 'Typewriter Reveal',
    group: 'story',
    parameters: {
      fontFamily: 'Roboto Mono',
      fontWeight: 500,
      fontSizePct: 3.6,
      animationIn: 'typewriter',
      effect: { typewriterCPS: 20 },
    },
    brandSubstitution: true,
  },
  {
    key: 'story_handwritten',
    name: 'Handwritten',
    group: 'story',
    parameters: {
      fontFamily: 'Caveat',
      fontWeight: 600,
      fontSizePct: 5,
      animationIn: 'fadeIn',
      animationInMs: 700,
    },
    brandSubstitution: true,
  },
  {
    key: 'story_notebook',
    name: 'Notebook',
    group: 'story',
    parameters: {
      fontFamily: 'Caveat',
      fontSizePct: 4.2,
      backgroundType: 'box',
      backgroundColor: '#FFF8DC',
      fillColor: '#1F2937',
      backgroundPaddingPx: 16,
      alignment: 'left',
      anchorX: 0.1,
      shadowColor: null,
    },
    brandSubstitution: false,
  },
  // Brand — always-on
  {
    key: 'brand_watermark',
    name: 'Watermark Corner',
    group: 'brand',
    parameters: {
      fontFamily: 'Inter',
      fontWeight: 600,
      fontSizePct: 2.2,
      anchorX: 0.9,
      anchorY: 0.06,
      alignment: 'right',
      animationIn: 'none',
      animationOut: 'none',
      fillColor: '#FFFFFFB3',
      shadowColor: null,
    },
    brandSubstitution: true,
  },
  {
    key: 'brand_logo_bug',
    name: 'Logo Bug',
    group: 'brand',
    parameters: {
      fontFamily: 'Montserrat',
      fontWeight: 800,
      fontSizePct: 2.6,
      anchorX: 0.1,
      anchorY: 0.06,
      alignment: 'left',
      animationIn: 'fadeIn',
      backgroundType: 'rounded_box',
      backgroundColor: '#00000080',
      backgroundPaddingPx: 8,
      backgroundRadiusPx: 8,
    },
    brandSubstitution: true,
  },
  {
    key: 'brand_reveal_wipe',
    name: 'Reveal Wipe',
    group: 'brand',
    parameters: {
      fontFamily: 'Montserrat',
      fontWeight: 800,
      fontSizePct: 6,
      animationIn: 'slideInLeft',
      animationOut: 'slideOutRight',
      backgroundType: 'box',
      backgroundColor: '#111111',
      backgroundPaddingPx: 20,
    },
    brandSubstitution: true,
  },
];

/** Default preset per shot role (A4.5 auto-suggestion). */
export const ROLE_PRESET: Record<'hook' | 'body' | 'cta', string> = {
  hook: 'hook_tiktok_native',
  body: 'subtitle_box',
  cta: 'cta_pulse_button',
};

/** 21.4b: every caption and label of a UGC video (projects with metadata.ugc). */
export const UGC_CAPTION_PRESET = 'subtitle_tiktok_classic';
/** 21.4b: the opening hook label on a UGC video's first actor shot. */
export const UGC_HOOK_PRESET = 'hook_tiktok_classic';
