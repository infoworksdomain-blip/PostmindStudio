// The shape layer of a carousel slide as SVG (21.6): background, dividers, avatar circles and the
// rounded frames pictures are clipped to. Glyphs are not drawn here: librsvg picks fonts through
// the host's fontconfig, which is not deterministic, so render.ts sets text with the bundled font
// files instead. Pure and deterministic (also used by the structural tests).
import type { SlideLayout } from './layout';

function attr(value: string | number): string {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** SVG markup of the slide's shapes, `width`×`height` with the layout's background. */
export function slideShapesSvg(layout: SlideLayout, avatarFill: string): string {
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">`,
    `<rect x="0" y="0" width="${layout.width}" height="${layout.height}" fill="${attr(layout.background)}"/>`,
  ];
  for (const el of layout.elements) {
    if (el.type === 'divider') {
      parts.push(
        `<rect data-role="divider" x="${el.x}" y="${el.y}" width="${el.width}" height="${el.thickness}" fill="${attr(el.colour)}"/>`,
      );
    } else if (el.type === 'avatar') {
      const r = el.size / 2;
      parts.push(
        `<circle data-role="avatar" cx="${el.x + r}" cy="${el.y + r}" r="${r}" fill="${attr(avatarFill)}"/>`,
      );
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

/** A white rounded rectangle, used as a `dest-in` mask to round a picture's corners. */
export function roundedMaskSvg(width: number, height: number, radius: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`;
}

/** A white circle mask for the profile picture. */
export function circleMaskSvg(size: number): string {
  const r = size / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/></svg>`;
}
