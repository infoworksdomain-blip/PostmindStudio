'use client';

import { encode } from 'uqr';

// Renders a QR code as SVG rects from uqr's module matrix (no innerHTML, no third-party QR
// service: the TOTP URI holds the shared secret and never leaves the browser).

export function QrCode({
  value,
  label,
  size = 176,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const { data } = encode(value, { ecc: 'M', border: 2 });
  const n = data.length;
  const cells: string[] = [];
  data.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) cells.push(`M${x} ${y}h1v1h-1z`);
    }),
  );
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="rounded-md bg-white"
    >
      <path d={cells.join('')} fill="#000" />
    </svg>
  );
}
