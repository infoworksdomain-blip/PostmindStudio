// Phase 13.7 — colour with transparency. Overlay colours are #RRGGBB or #RRGGBBAA (params.ts);
// <input type="color"> only edits #rrggbb, so the alpha byte is edited separately.

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const HEX8 = /^#[0-9a-fA-F]{8}$/;

export function splitHex(colour: string | null, fallback: string): { rgb: string; alpha: number } {
  if (colour && HEX8.test(colour))
    return {
      rgb: colour.slice(0, 7).toLowerCase(),
      alpha: Math.round((parseInt(colour.slice(7, 9), 16) / 255) * 100) / 100,
    };
  if (colour && HEX6.test(colour)) return { rgb: colour.toLowerCase(), alpha: 1 };
  return { rgb: fallback, alpha: 1 };
}

/** #rrggbb when opaque, else #rrggbbaa (alpha 0–1). */
export function joinHex(rgb: string, alpha: number): string {
  const a = Math.min(1, Math.max(0, alpha));
  if (a >= 1) return rgb.toLowerCase();
  const byte = Math.round(a * 255)
    .toString(16)
    .padStart(2, '0');
  return `${rgb.toLowerCase()}${byte}`;
}
