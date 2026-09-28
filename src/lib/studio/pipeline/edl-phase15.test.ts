import { describe, expect, it } from 'vitest';
import { buildShotstackComposition, editDuration, type EdlShot } from './edl';
import { brandImageRect, cardSec, IMAGE_CARD_SEC, MAX_VIDEO_CARD_SEC } from './edl-brand';
import { duckedMusicClips, mergeSpans } from './edl-music';
import { motionPalette } from './motion-graphics';
import {
  fourKAllowed,
  outputDimensions,
  parseRenderOptions,
  resolvePreset,
  withPreset,
} from './render-presets';
import { aiLabelText } from './ai-label';

// Phase 15 Track B — EDL additions: brand media (15.B1), narration trim (15.B3), music ducking
// (15.B4), presets (15.B7), motion cards (15.B8), P2 platform card, P6 AI label, scripts/RTL.

type Clip = { asset: Record<string, unknown>; start: number; length: number } & Record<
  string,
  unknown
>;
const tracksOf = (edit: Record<string, unknown>) =>
  (edit.timeline as { tracks: Array<{ clips: Clip[] }> }).tracks;
const allClips = (edit: Record<string, unknown>) => tracksOf(edit).flatMap((t) => t.clips);

const shots: EdlShot[] = [
  {
    id: 's1',
    durationSec: 4,
    visualTreatment: 'AI_CLIP',
    visualSrc: 'https://v/1.mp4',
    visualKind: 'video',
    voiceSrc: 'https://a/1.mp3',
    onScreenText: 'Fresh bread',
  },
  { id: 's2', durationSec: 3, visualTreatment: 'TEXT_CARD', cardText: 'Subscribe' },
];

const media = {
  logo: { src: 'https://b/logo.png', width: 400, height: 200 },
  watermark: { src: 'https://b/mark.png', width: 300, height: 300 },
  intro: { src: 'https://b/intro.png', kind: 'image' as const },
  outro: { src: 'https://b/outro.mp4', kind: 'video' as const, durationSec: 20 },
};

describe('15.B1 brand media on the timeline', () => {
  it('puts intro/outro cards around the shots and the logo/watermark over the content', () => {
    const { edit, summary } = buildShotstackComposition({
      aspectRatio: '9:16',
      shots,
      brandMedia: media,
    });
    const clips = allClips(edit);
    const intro = clips.find((c) => c.asset.src === 'https://b/intro.png');
    const outro = clips.find((c) => c.asset.src === 'https://b/outro.mp4');
    expect(intro).toMatchObject({ start: 0, length: IMAGE_CARD_SEC, fit: 'contain' });
    expect(outro).toMatchObject({ start: IMAGE_CARD_SEC + 7, length: MAX_VIDEO_CARD_SEC });
    const logo = clips.find((c) => c.asset.src === 'https://b/logo.png');
    expect(logo).toMatchObject({
      start: IMAGE_CARD_SEC,
      length: 7,
      position: 'topRight',
      fit: 'contain',
    });
    const mark = clips.find((c) => c.asset.src === 'https://b/mark.png');
    expect(mark).toMatchObject({ start: IMAGE_CARD_SEC, length: 7, position: 'topLeft' });
    // Shots move after the intro; narration too.
    const voice = clips.find((c) => c.asset.src === 'https://a/1.mp3');
    expect(voice?.start).toBe(IMAGE_CARD_SEC);
    expect(summary).toMatchObject({
      introSec: IMAGE_CARD_SEC,
      outroSec: MAX_VIDEO_CARD_SEC,
      totalSec: IMAGE_CARD_SEC + 7 + MAX_VIDEO_CARD_SEC,
      brand: { logo: true, intro: true, outro: true },
    });
    expect(summary.brand.watermark).toMatchObject({
      startSec: IMAGE_CARD_SEC,
      endSec: IMAGE_CARD_SEC + 7,
    });
    expect(editDuration(shots, media)).toBe(summary.totalSec);
  });

  it('computes the watermark rect for a contained, scaled image', () => {
    expect(
      brandImageRect({ width: 300, height: 300 }, { width: 1080, height: 1920 }, 0.16, 'topLeft'),
    ).toEqual({ x: 32, y: 58, width: 173, height: 173 });
    expect(cardSec(undefined)).toBe(0);
  });

  it('adds timeline.fonts for the brand font and uses it in text cards', () => {
    const { edit } = buildShotstackComposition({
      aspectRatio: '1:1',
      shots,
      brand: { fontFamily: 'Brandon', fontSources: ['https://s/font.ttf'] },
    });
    expect((edit.timeline as { fonts: unknown }).fonts).toEqual([{ src: 'https://s/font.ttf' }]);
    const card = allClips(edit).find((c) => c.asset.html === '<p>Subscribe</p>');
    expect(String(card?.asset.css)).toContain("'Brandon'");
  });
});

describe('scripts and RTL (i18n/scripts.ts)', () => {
  it('sets Arabic in Noto Sans Arabic with dir="rtl"; Latin keeps the brand font', () => {
    const { edit, summary } = buildShotstackComposition({
      aspectRatio: '9:16',
      shots,
      brand: { fontFamily: 'Brandon' },
      language: 'ar',
    });
    const card = allClips(edit).find((c) => String(c.asset.html).includes('Subscribe'));
    expect(card?.asset.html).toBe('<p dir="rtl">Subscribe</p>');
    expect(String(card?.asset.css)).toContain("'Noto Sans Arabic'");
    expect(summary.brand.fontFamily).toBe('Noto Sans Arabic');
    const hi = buildShotstackComposition({ aspectRatio: '9:16', shots, language: 'hi' });
    expect(hi.summary.brand.fontFamily).toBe('Noto Sans Devanagari');
    const zh = buildShotstackComposition({ aspectRatio: '9:16', shots, language: 'zh-Hans' });
    expect(zh.summary.brand.fontFamily).toBe('Noto Sans SC');
  });
});

describe('P6 AI label and P2 platform card', () => {
  it('adds a translated AI label over the content only when asked', () => {
    const on = buildShotstackComposition({
      aspectRatio: '9:16',
      shots,
      aiLabel: true,
      language: 'fr',
    });
    const label = allClips(on.edit).find((c) => String(c.asset.html).includes(aiLabelText('fr')));
    expect(label).toMatchObject({ start: 0, length: 7, position: 'top' });
    expect(on.summary.brand.aiLabel).toBe(true);
    const off = buildShotstackComposition({ aspectRatio: '9:16', shots });
    expect(off.summary.brand.aiLabel).toBe(false);
    expect(aiLabelText('xx')).toBe('AI-generated');
    expect(aiLabelText('zh-Hans')).toBe('AI生成');
  });

  it('appends the platform card after the outro and counts it as outro time', () => {
    const { edit, summary } = buildShotstackComposition({
      aspectRatio: '9:16',
      shots,
      platformCard: { src: 'https://p/made-with.png', kind: 'image' },
    });
    const card = allClips(edit).find((c) => c.asset.src === 'https://p/made-with.png');
    expect(card).toMatchObject({ start: 7, length: IMAGE_CARD_SEC });
    expect(summary).toMatchObject({ outroSec: IMAGE_CARD_SEC, brand: { platformCard: true } });
  });
});

describe('15.B3 narration trimmed at a word boundary', () => {
  it('stops the voice clip at voiceTrimSec', () => {
    const { edit, summary } = buildShotstackComposition({
      aspectRatio: '9:16',
      shots: [{ ...(shots[0] as EdlShot), voiceTrimSec: 3.4 }],
    });
    expect(allClips(edit).find((c) => c.asset.src === 'https://a/1.mp3')?.length).toBe(3.4);
    expect(summary.shots[0]?.voiceClipSec).toBe(3.4);
  });
});

describe('15.B4 music ducking', () => {
  it('splits the bed per narrated/silent span with trim into a looping track', () => {
    const clips = duckedMusicClips({
      src: 'm',
      trackSec: 5,
      spans: [
        { startSec: 0, endSec: 4, volume: 0.2 },
        { startSec: 4, endSec: 7, volume: 0.7 },
      ],
    });
    expect(clips.map((c) => [c.start, c.length, (c.asset as { volume: number }).volume])).toEqual([
      [0, 4, 0.2],
      [4, 1, 0.7],
      [5, 2, 0.7],
    ]);
    expect((clips[1]?.asset as { trim?: number }).trim).toBe(4);
    expect((clips[2]?.asset as { trim?: number }).trim).toBeUndefined();
    expect((clips[2]?.asset as { effect?: string }).effect).toBe('fadeOut');
  });

  it('merges adjacent spans at the same level and drops empty ones', () => {
    expect(
      mergeSpans([
        { startSec: 0, endSec: 2, volume: 0.2 },
        { startSec: 2, endSec: 3, volume: 0.2 },
        { startSec: 3, endSec: 3, volume: 0.7 },
      ]),
    ).toEqual([{ startSec: 0, endSec: 3, volume: 0.2 }]);
  });

  it('keeps music loud under intro/outro cards when the video is narrated', () => {
    const { edit } = buildShotstackComposition({
      aspectRatio: '9:16',
      shots: [shots[0] as EdlShot],
      brandMedia: { intro: media.intro },
      musicSrc: 'https://m/t.mp3',
      musicDurationSec: 60,
    });
    const music = tracksOf(edit).at(-1)?.clips ?? [];
    expect(music.map((c) => [c.start, c.length, c.asset.volume])).toEqual([
      [0, IMAGE_CARD_SEC, 0.7],
      [IMAGE_CARD_SEC, 4, 0.2],
    ]);
  });
});

describe('15.B7 render presets', () => {
  it('resolves fps, drafts and 4K by platform and tier', () => {
    expect(resolvePreset({ platform: 'tiktok', planTier: 'BASIC', options: {} })).toEqual({
      resolution: '1080',
      fps: 30,
      quality: 'high',
    });
    expect(
      resolvePreset({
        platform: 'youtube',
        planTier: 'PLUS',
        options: { youtubeResolution: '4k', fps: 60 },
      }),
    ).toEqual({ resolution: '4k', fps: 60, quality: 'high' });
    // A downgraded tier or another platform falls back to 1080.
    expect(
      resolvePreset({
        platform: 'youtube',
        planTier: 'STANDARD',
        options: { youtubeResolution: '4k' },
      }).resolution,
    ).toBe('1080');
    expect(
      resolvePreset({
        platform: 'tiktok',
        planTier: 'ENTERPRISE',
        options: { youtubeResolution: '4k' },
      }).resolution,
    ).toBe('1080');
    expect(
      resolvePreset({ platform: 'x', planTier: 'PLUS', options: { draft: true, fps: 24 } }),
    ).toEqual({
      resolution: '1080',
      scaleTo: 'hd',
      fps: 24,
      quality: 'medium',
    });
    expect(fourKAllowed('youtube', 'ENTERPRISE')).toBe(true);
    expect(parseRenderOptions({ fps: 25 })).toEqual({});
  });

  it('lays out 4K at 2160 and writes the preset output', () => {
    expect(outputDimensions('9:16', '4k')).toEqual({ width: 2160, height: 3840 });
    const { edit, summary } = buildShotstackComposition({
      aspectRatio: '16:9',
      shots,
      preset: { resolution: '4k', fps: 60, quality: 'high' },
    });
    expect(edit.output).toEqual({
      format: 'mp4',
      resolution: '4k',
      aspectRatio: '16:9',
      fps: 60,
      quality: 'high',
    });
    expect(summary.frame).toEqual({ width: 3840, height: 2160 });
    expect(
      withPreset({ output: {} }, '9:16', {
        resolution: '1080',
        scaleTo: 'hd',
        fps: 30,
        quality: 'medium',
      }).output,
    ).toMatchObject({ resolution: '1080', scaleTo: 'hd' });
  });
});

describe('15.B8 motion-graphics cards', () => {
  it('renders a shape background, an animated accent bar and the text on separate tracks', () => {
    const { edit } = buildShotstackComposition({
      aspectRatio: '9:16',
      shots: [
        {
          id: 'm1',
          durationSec: 3,
          visualTreatment: 'MOTION_GRAPHICS',
          cardText: '3 loaves, 1 price',
          onScreenText: 'ignored caption',
          transitionOut: 'fade',
        },
      ],
      brand: { palette: ['#112233', '#ffeecc', '#ff0066'] },
    });
    const tracks = tracksOf(edit);
    const background = tracks
      .flatMap((t) => t.clips)
      .find((c) => c.asset.type === 'shape' && c.asset.width === 1080);
    expect(background).toMatchObject({
      asset: { shape: 'rectangle', fill: { color: '#112233', opacity: 1 } },
      transition: { in: 'fade', out: 'fade' },
    });
    const accent = tracks
      .flatMap((t) => t.clips)
      .find((c) => c.asset.type === 'shape' && c.asset.width !== 1080);
    expect(accent).toMatchObject({
      asset: { fill: { color: '#ff0066' } },
      transition: { in: 'carouselLeft', out: 'carouselRight' },
    });
    const text = tracks.flatMap((t) => t.clips).find((c) => c.asset.type === 'html');
    expect(text?.asset.html).toBe('<p>3 loaves, 1 price</p>');
    // No separate caption for a motion card (it carries its own text).
    expect(tracks.flatMap((t) => t.clips).filter((c) => c.asset.type === 'html')).toHaveLength(1);
    // Each track holds non-overlapping clips.
    for (const t of tracks) expect(t.clips.length).toBeLessThanOrEqual(1);
    expect(motionPalette(['bad'])).toEqual({
      background: '#111111',
      text: '#ffffff',
      accent: '#ffffff',
    });
  });
});
