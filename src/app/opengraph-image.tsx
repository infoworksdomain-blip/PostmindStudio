import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { STUDIO_CLIPS } from '@/lib/marketing/media';

// 25.5 — the link-preview image for every public page (Open Graph and X cards), 1200×630: the
// Daylight canvas, the PostMind mark, the headline and a real Studio poster frame in a phone.
// Type: the renderer's bundled Noto Sans (Geist ships only as WOFF2 and the variable TTFs in
// public/fonts are not readable by the image renderer). Rendered at build time from public/.

export const alt = 'PostMind Studio: create, plan and publish short videos from one brief';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const INK = '#1a1d22';
const INK_2 = '#5c6370';
const CANVAS = '#f7f8fa';
const SIGNAL = '#e2552f';

export default async function OpengraphImage() {
  const root = process.cwd();
  const poster = await readFile(
    join(root, 'public', 'marketing', STUDIO_CLIPS.seedanceBread.poster.fallback.path),
  );
  const posterSrc = `data:image/jpeg;base64,${poster.toString('base64')}`;

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        background: CANVAS,
        color: INK,
        padding: '64px 72px',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, paddingRight: 48 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              background: INK,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div style={{ width: 18, height: 18, borderRadius: 9, background: SIGNAL }} />
          </div>
          <div style={{ fontSize: 30, letterSpacing: -0.5, display: 'flex' }}>
            PostMind&nbsp;<span style={{ color: INK_2 }}>Studio</span>
          </div>
        </div>
        <div
          style={{
            marginTop: 'auto',
            fontSize: 68,
            lineHeight: 1.04,
            letterSpacing: -2.5,
            display: 'flex',
            flexWrap: 'wrap',
          }}
        >
          Create, plan and publish your social videos from one brief.
        </div>
        <div style={{ marginTop: 28, fontSize: 26, color: INK_2, display: 'flex' }}>
          Short videos and posts for small businesses
        </div>
      </div>
      <div
        style={{
          width: 288,
          height: 502,
          borderRadius: 40,
          background: INK,
          padding: 10,
          display: 'flex',
          boxShadow: '0 30px 60px -20px rgba(20,24,31,0.45)',
        }}
      >
        <img
          src={posterSrc}
          width={268}
          height={482}
          alt=""
          style={{ borderRadius: 31, objectFit: 'cover', width: 268, height: 482 }}
        />
      </div>
    </div>,
    size,
  );
}
