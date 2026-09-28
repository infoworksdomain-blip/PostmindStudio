// Shared timeline helpers for the Layer 6 edit builders (no imports, so any EDL module can use
// them without an import cycle).

export function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;
/** CSS font-family values Studio writes into Shotstack HTML assets. */
export const SAFE_FONT = /^[A-Za-z0-9 -]{1,64}$/;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
