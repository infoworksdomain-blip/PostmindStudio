import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FONTS as ONBOARDING_FONTS } from '@/components/studio/onboarding/brand-kit-options';
import { hostedFontFileName } from '@/lib/studio/fonts-host';
import { SCRIPT_FONTS } from '@/lib/studio/i18n/scripts';
import { DEFAULT_STYLE, resolveStyle } from '@/lib/studio/overlays/params';
import { BUILT_IN_PRESETS } from '@/lib/studio/overlays/presets';
import { THUMBNAIL_FONT_FAMILY } from '@/lib/studio/services/thumbnails';
import { readFontFacts } from '../helpers/ttf';

// BACKLOG 20.7 — Studio serves its own render fonts from public/fonts/ (APP_URL/fonts). Every
// family the code can put into a render must have its file there, read from the same constants
// the code uses (presets, the default overlay style, the script → Noto map, the onboarding font
// picker, the thumbnail font), plus a scan for family names written as literals in src/ and demo/
// so a new preset, fixture or default cannot slip past.

const ROOT = join(__dirname, '..', '..');
const FONTS_DIR = join(ROOT, 'public', 'fonts');

// A property written as a literal (`fontFamily: 'Inter'`), not the else-branch of a ternary.
const LITERAL = /\b(?:fontFamily|fontPrimary|fontSecondary)[ \t]*:[ \t]*'([^']+)'/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function literalFamilies(): Set<string> {
  const out = new Set<string>();
  for (const file of [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'demo'))])
    for (const m of readFileSync(file, 'utf8').matchAll(LITERAL))
      if (!m[1]!.startsWith('upload:')) out.add(m[1]!);
  return out;
}

const codeFamilies = new Set<string>([
  ...Object.values(SCRIPT_FONTS),
  DEFAULT_STYLE.fontFamily,
  ...BUILT_IN_PRESETS.map((p) => resolveStyle(p.parameters).fontFamily),
  ...ONBOARDING_FONTS,
  THUMBNAIL_FONT_FAMILY,
]);
const allFamilies = [...new Set([...codeFamilies, ...literalFamilies()])].sort();
const shipped = readdirSync(FONTS_DIR).filter((f) => f.endsWith('.ttf'));

describe('self-hosted render fonts (public/fonts)', () => {
  it('knows the families the code uses (sanity: the sources were read)', () => {
    expect(allFamilies).toEqual(
      expect.arrayContaining(['Montserrat', 'Noto Sans SC', 'Bebas Neue', 'DM Sans', 'Inter']),
    );
  });

  it.each(allFamilies)('%s is shipped as <FamilyNoSpaces>.ttf', (family) => {
    expect(shipped).toContain(hostedFontFileName(family));
  });

  // The family each shipped file must carry: the code's name for it, else (an extra family an
  // operator added for brand kits) the Family column of its SOURCES.md row.
  const sources = readFileSync(join(FONTS_DIR, 'SOURCES.md'), 'utf8');
  const sourceRows = new Map(
    sources
      .split('\n')
      .filter((line) => /^\| `[A-Za-z0-9]+\.ttf` \|/.test(line))
      .map((line) => {
        const [, file, family] = line.split('|').map((cell) => cell.trim());
        return [file!.replace(/`/g, ''), family!] as const;
      }),
  );
  const codeFamilyOf = new Map(allFamilies.map((f) => [hostedFontFileName(f), f]));
  const familyOf = (file: string) => codeFamilyOf.get(file) ?? sourceRows.get(file);

  it.each(shipped)(
    '%s is a TrueType font named as the family Studio asks for, Regular by default',
    (file) => {
      const family = familyOf(file);
      expect(family, 'no code reference and no SOURCES.md row').toBeDefined();
      expect(hostedFontFileName(family!)).toBe(file);
      const facts = readFontFacts(readFileSync(join(FONTS_DIR, file)));
      // TrueType outlines (0x00010000), not a CFF .otf renamed to .ttf.
      expect(facts.sfntVersion).toBe(0x00010000);
      // Shotstack matches font.family against the file's family name.
      expect(facts.family).toBe(family);
      if (facts.typographicFamily !== undefined) expect(facts.typographicFamily).toBe(family);
      // FFmpeg drawtext (pre-render, thumbnails) draws a variable font's default instance.
      expect(facts.weightClass).toBe(400);
      const wght = facts.axes.find((a) => a.tag === 'wght');
      if (wght) expect(wght.default).toBe(400);
    },
  );

  it.each(shipped)('%s has its licence and a SOURCES.md entry', (file) => {
    const stem = file.replace(/\.ttf$/, '');
    const licences = readdirSync(join(FONTS_DIR, 'licenses')).filter((l) =>
      l.startsWith(`${stem}-`),
    );
    expect(licences.length).toBeGreaterThan(0);
    expect(sourceRows.has(file)).toBe(true);
  });

  it('SOURCES.md lists the shipped files and their total size', () => {
    expect([...sourceRows.keys()].sort()).toEqual([...shipped].sort());
    const total = shipped.reduce((sum, f) => sum + statSync(join(FONTS_DIR, f)).size, 0);
    expect(sources).toContain(`${total.toLocaleString('en-GB')} bytes`);
  });

  it('the Docker image copies public/ (next start serves /fonts from it)', () => {
    expect(readFileSync(join(ROOT, 'Dockerfile'), 'utf8')).toMatch(
      /^COPY --from=build [^\n]*\/app\/public \.\/public$/m,
    );
    expect(existsSync(join(ROOT, '.dockerignore'))).toBe(true);
    expect(readFileSync(join(ROOT, '.dockerignore'), 'utf8')).not.toMatch(/^\/?public\/?$/m);
  });
});
