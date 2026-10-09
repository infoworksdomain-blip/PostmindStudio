import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { STUDIO_CLIPS } from '@/lib/marketing/media';

// 25.5 — the link-preview image for every public page (Open Graph and X cards), 1200×630: the
// Daylight canvas, the PostMind Studio logo (26.2: the lockup from public/brand), the headline and
// a real Studio poster frame in a phone.
// 26.2: set in Geist, the site's typeface: static 400 and 600 instances in public/fonts/og (the
// renderer reads TTF only and draws a variable font's default; scripts/fonts/geist-og-instances.mjs
// builds them from the @fontsource-variable/geist WOFF2). Rendered at build time from public/.
// src/app/twitter-image.tsx serves the same image for X cards.

export const alt = 'PostMind Studio: create, plan and publish short videos from one brief';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const INK = '#1a1d22';
const INK_2 = '#5c6370';
const CANVAS = '#f7f8fa';
const FAMILY = 'Geist';

async function geist(file: string): Promise<Buffer> {
  return readFile(join(process.cwd(), 'public', 'fonts', 'og', file));
}

export default async function OpengraphImage() {
  const root = process.cwd();
  const poster = await readFile(
    join(root, 'public', 'marketing', STUDIO_CLIPS.seedanceBread.poster.fallback.path),
  );
  const posterSrc = `data:image/jpeg;base64,${poster.toString('base64')}`;
  const logo = await readFile(join(root, 'public', 'brand', 'logo-og.png'));
  const logoSrc = `data:image/png;base64,${logo.toString('base64')}`;
  const [regular, semiBold] = await Promise.all([
    geist('Geist-Regular.ttf'),
    geist('Geist-SemiBold.ttf'),
  ]);

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        background: CANVAS,
        color: INK,
        fontFamily: FAMILY,
        padding: '64px 72px',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, paddingRight: 48 }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- next/og renders plain <img> */}
        <img src={logoSrc} width={289} height={96} alt="" style={{ width: 289, height: 96 }} />
        <div
          style={{
            marginTop: 'auto',
            fontSize: 68,
            fontWeight: 600,
            lineHeight: 1.04,
            letterSpacing: '-0.035em',
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
    {
      ...size,
      fonts: [
        { name: FAMILY, data: regular, weight: 400, style: 'normal' },
        { name: FAMILY, data: semiBold, weight: 600, style: 'normal' },
      ],
    },
  );
}
