import { ImageResponse } from 'next/og';

// 25.5 — the home-screen icon (iOS adds its own rounded mask): the PostMind mark, an ink square
// with the vermilion record dot, at 180×180. Same drawing as src/app/icon.svg.

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#1a1d22',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{ width: 68, height: 68, borderRadius: 34, background: '#e2552f' }} />
    </div>,
    size,
  );
}
