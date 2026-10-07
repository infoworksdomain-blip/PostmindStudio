import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  composite,
  contrastRatio,
  oklchToLinearRgb,
  parseOklch,
  relativeLuminance,
} from '@/lib/design/contrast';

// BACKLOG 25.2 — the "Daylight and Darkroom" tokens in src/app/globals.css meet WCAG AA in both
// themes: 4.5:1 for text pairs, 3:1 for UI pairs (focus ring, field edges, status icons, chart
// marks). The values are read from the stylesheet itself, so a token edit that breaks a pair
// fails here.

const css = readFileSync(join(__dirname, '..', '..', 'src', 'app', 'globals.css'), 'utf8');

function block(selector: string): Map<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in globals.css`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const vars = new Map<string, string>();
  // Single-line custom properties only (multi-line values such as shadows are not colours).
  for (const m of body.matchAll(/^\s*(--[\w-]+):\s*([^;\n]+);/gm)) vars.set(m[1]!, m[2]!.trim());
  return vars;
}

const light = block(':root');
const dark = new Map([...light, ...block('.dark')]);

function resolve(theme: Map<string, string>, name: string, seen: string[] = []): string {
  const value = theme.get(name);
  if (value === undefined) throw new Error(`${name} is not defined`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (!ref) return value;
  if (seen.includes(name)) throw new Error(`var() cycle at ${name}`);
  return resolve(theme, ref[1]!, [...seen, name]);
}

const TEXT = 4.5;
const UI = 3;

/** [foreground, background, minimum ratio] */
const PAIRS: Array<[string, string, number]> = [
  // Ink on every neutral surface it is written on.
  ['--foreground', '--background', TEXT],
  ['--card-foreground', '--card', TEXT],
  ['--popover-foreground', '--popover', TEXT],
  ['--foreground', '--surface-raised', TEXT],
  ['--foreground', '--surface-active', TEXT],
  ['--foreground-secondary', '--background', TEXT],
  ['--foreground-secondary', '--card', TEXT],
  ['--foreground-secondary', '--surface-raised', TEXT],
  ['--muted-foreground', '--background', TEXT],
  ['--muted-foreground', '--card', TEXT],
  ['--muted-foreground', '--muted', TEXT],
  ['--secondary-foreground', '--secondary', TEXT],
  ['--accent-foreground', '--accent', TEXT],
  ['--sidebar-foreground', '--sidebar', TEXT],
  ['--sidebar-accent-foreground', '--sidebar-accent', TEXT],
  ['--muted-foreground', '--sidebar', TEXT],
  // Signal: a filled primary button, signal-coloured text and links, the soft signal wash.
  ['--primary-foreground', '--primary', TEXT],
  ['--sidebar-primary-foreground', '--sidebar-primary', TEXT],
  ['--primary', '--background', TEXT],
  ['--primary', '--card', TEXT],
  ['--primary', '--signal-soft', TEXT],
  ['--foreground', '--signal-soft', TEXT],
  // Data teal as text and on its wash.
  ['--data', '--background', TEXT],
  ['--data', '--card', TEXT],
  ['--foreground', '--data-soft', TEXT],
  // Status text on the canvas, a card and its own soft wash; status fills as UI marks.
  ['--destructive', '--background', TEXT],
  ['--destructive-foreground', '--background', TEXT],
  ['--destructive-foreground', '--card', TEXT],
  ['--destructive-foreground', '--destructive-soft', TEXT],
  ['--success-foreground', '--background', TEXT],
  ['--success-foreground', '--card', TEXT],
  ['--success-foreground', '--success-soft', TEXT],
  ['--warning-foreground', '--background', TEXT],
  ['--warning-foreground', '--card', TEXT],
  ['--warning-foreground', '--warning-soft', TEXT],
  ['--foreground', '--warning-soft', TEXT],
  ['--foreground', '--destructive-soft', TEXT],
  ['--foreground', '--success-soft', TEXT],
  ['--success', '--background', UI],
  ['--warning', '--background', UI],
  ['--destructive', '--card', UI],
  // Text on a solid destructive fill (the kill switch's "halted" badge uses text-background).
  ['--background', '--destructive', TEXT],
  // Focus ring and form-field edges (WCAG 1.4.11).
  ['--ring', '--background', UI],
  ['--ring', '--card', UI],
  ['--input', '--background', UI],
  ['--input', '--card', UI],
  // Chart marks against the card they sit on.
  ['--chart-1', '--card', UI],
  ['--chart-2', '--card', UI],
  ['--chart-3', '--card', UI],
  ['--chart-4', '--card', UI],
  ['--chart-5', '--card', UI],
];

describe.each([
  ['light (Daylight)', light],
  ['dark (Darkroom)', dark],
])('%s tokens', (_name, theme) => {
  it.each(PAIRS)('%s on %s ≥ %s:1', (fg, bg, min) => {
    const ratio = contrastRatio(resolve(theme, fg), resolve(theme, bg));
    expect(ratio, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
  });

  // Status pills and chips across the app write the status colour on a 10–15% wash of itself
  // (e.g. `bg-success/12 text-success`), over a card or the canvas; axe measured these in CI.
  it.each([
    ['--primary', 0.15],
    ['--success', 0.15],
    ['--destructive', 0.15],
  ])('%s text on a %s wash of itself stays readable', (token, alpha) => {
    const fg = oklchToLinearRgb(parseOklch(resolve(theme, token)));
    for (const surface of ['--card', '--background']) {
      const under = oklchToLinearRgb(parseOklch(resolve(theme, surface)));
      const wash = relativeLuminance(composite(fg, alpha, under));
      const text = relativeLuminance(fg);
      const ratio = (Math.max(wash, text) + 0.05) / (Math.min(wash, text) + 0.05);
      expect(ratio, ` on its wash over  is :1`).toBeGreaterThanOrEqual(TEXT);
    }
  });

  it('defines every token the Tailwind theme maps', () => {
    const mapped = [...css.matchAll(/--color-[\w-]+:\s*var\((--[\w-]+)\)/g)].map((m) => m[1]!);
    for (const name of mapped) expect(() => resolve(theme, name)).not.toThrow();
  });
});

describe('globals.css', () => {
  it('no longer paints the film-grain layer over the canvas', () => {
    expect(css).not.toMatch(/body::before/);
    expect(css).not.toMatch(/feTurbulence/);
  });

  it('keeps the reduced-motion rule and the RTL icon flip', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/\[dir='rtl'\] \.cn-rtl-flip/);
  });

  it('uses Geist for UI and display and Geist Mono for data', () => {
    expect(css).toMatch(/--font-sans: 'Geist Variable'/);
    expect(css).toMatch(/--font-display: 'Geist Variable'/);
    expect(css).toMatch(/--font-mono: 'Geist Mono Variable'/);
    expect(css).not.toMatch(/Instrument Serif|Inter Variable/);
  });
});
