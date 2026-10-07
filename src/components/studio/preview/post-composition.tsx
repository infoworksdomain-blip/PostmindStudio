'use client';

import type { CSSProperties } from 'react';
import { AbsoluteFill, Img, interpolate, OffthreadVideo, Series, useCurrentFrame } from 'remotion';
import type {
  PreviewMedia,
  PreviewSlide,
  StoryboardShot,
} from '@/lib/studio/services/post-preview-media';
import { segmentFrames } from './preview-model';

// BACKLOG 24.2 — the Remotion composition behind the side panel's instant preview
// (https://www.remotion.dev/docs/player, read 2026-10-06: the Player takes the component
// directly, no <Composition>). It is a faithful-enough stand-in for the real output: the same
// frame size as the render, slides for their own durations with the TikTok-classic text look,
// the wall-of-text block, the finished render itself, or — while a video is still being made —
// its storyboard (each shot's still, or its words on a card). Logical CSS only (RTL-safe).

export interface PostCompositionLabels {
  /** "Shot {n} of {total}" already formatted per shot by the caller. */
  shot: (n: number, total: number) => string;
  storyboard: string;
}

export interface PostCompositionProps extends Record<string, unknown> {
  media: PreviewMedia;
  caption: string | null;
  dir: 'ltr' | 'rtl';
  labels: PostCompositionLabels;
}

/**
 * The browser's own UI font stack (the app's Inter first). A browser-only preview, never sent to
 * a renderer, so it is not one of the self-hosted render fonts in public/fonts.
 */
const PREVIEW_FONT = ['Inter Variable', 'system-ui', 'sans-serif'].join(', ');

/** TikTok-classic text: white, heavy, black outline, no box (formats/caption-style.ts). */
const CLASSIC: CSSProperties = {
  color: 'white',
  fontWeight: 800,
  fontFamily: PREVIEW_FONT,
  textAlign: 'center',
  WebkitTextStroke: '6px black',
  paintOrder: 'stroke fill',
  lineHeight: 1.15,
  whiteSpace: 'pre-line',
};

function KenBurns({ src }: { src: string }) {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, 120], [1, 1.08], { extrapolateRight: 'clamp' });
  return (
    <Img
      src={src}
      style={{ inlineSize: '100%', blockSize: '100%', objectFit: 'cover', scale: String(scale) }}
    />
  );
}

function Slide({ slide, rendered }: { slide: PreviewSlide; rendered: boolean }) {
  return (
    <AbsoluteFill style={{ backgroundColor: '#111' }}>
      {slide.imageUrl &&
        (rendered ? (
          <Img
            src={slide.imageUrl}
            style={{ inlineSize: '100%', blockSize: '100%', objectFit: 'contain' }}
          />
        ) : (
          <KenBurns src={slide.imageUrl} />
        ))}
      {slide.text && !rendered && (
        <AbsoluteFill
          style={{ justifyContent: 'center', paddingInline: '8%', backgroundColor: '#0006' }}
        >
          <p style={{ ...CLASSIC, fontSize: 84, margin: 0 }}>{slide.text}</p>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
}

function Shot({ shot, label, heading }: { shot: StoryboardShot; label: string; heading: string }) {
  return (
    <AbsoluteFill style={{ backgroundColor: '#1d1b2e' }}>
      {shot.stillUrl ? (
        <KenBurns src={shot.stillUrl} />
      ) : (
        <AbsoluteFill
          style={{
            background: 'linear-gradient(160deg, #3b2f73 0%, #1d1b2e 70%)',
            justifyContent: 'center',
            paddingInline: '10%',
          }}
        >
          <p style={{ color: '#fff9', fontSize: 40, margin: 0, letterSpacing: 4 }}>{heading}</p>
          {shot.text && (
            <p style={{ ...CLASSIC, fontSize: 64, textAlign: 'start', marginBlockStart: 24 }}>
              {shot.text}
            </p>
          )}
        </AbsoluteFill>
      )}
      <p
        style={{
          position: 'absolute',
          insetBlockStart: 48,
          insetInlineStart: 48,
          margin: 0,
          padding: '8px 20px',
          borderRadius: 999,
          backgroundColor: '#000a',
          color: 'white',
          fontSize: 36,
          fontFamily: PREVIEW_FONT,
        }}
      >
        {label}
      </p>
    </AbsoluteFill>
  );
}

function CaptionStrip({ caption }: { caption: string }) {
  return (
    <p
      style={{
        position: 'absolute',
        insetInline: 48,
        insetBlockEnd: 64,
        margin: 0,
        color: 'white',
        fontSize: 38,
        fontFamily: PREVIEW_FONT,
        textShadow: '0 2px 6px #000c',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}
    >
      {caption}
    </p>
  );
}

function Body({ media, labels }: Pick<PostCompositionProps, 'media' | 'labels'>) {
  const frames = segmentFrames(media);
  switch (media.kind) {
    case 'video':
      return <OffthreadVideo src={media.url} style={{ inlineSize: '100%', blockSize: '100%' }} />;
    case 'text':
      return (
        <AbsoluteFill
          style={{
            background: 'linear-gradient(180deg, #4b6584 0%, #1e272e 100%)',
            justifyContent: 'center',
            paddingInline: '9%',
          }}
        >
          <p style={{ ...CLASSIC, fontSize: 72, margin: 0 }}>{media.text}</p>
        </AbsoluteFill>
      );
    case 'slides':
      return (
        <Series>
          {media.slides.map((slide, i) => (
            <Series.Sequence key={i} durationInFrames={frames[i] ?? 1}>
              <Slide slide={slide} rendered={media.rendered} />
            </Series.Sequence>
          ))}
        </Series>
      );
    case 'storyboard':
      return (
        <Series>
          {media.shots.map((shot, i) => (
            <Series.Sequence key={shot.id} durationInFrames={frames[i] ?? 1}>
              <Shot
                shot={shot}
                heading={labels.storyboard}
                label={labels.shot(i + 1, media.shots.length)}
              />
            </Series.Sequence>
          ))}
        </Series>
      );
    case 'none':
      return null;
  }
}

export function PostComposition({ media, caption, dir, labels }: PostCompositionProps) {
  return (
    <AbsoluteFill dir={dir} style={{ backgroundColor: 'black', overflow: 'hidden' }}>
      <Body media={media} labels={labels} />
      {caption && media.kind !== 'video' && <CaptionStrip caption={caption} />}
    </AbsoluteFill>
  );
}
