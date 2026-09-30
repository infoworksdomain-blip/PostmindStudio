import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '../i18n/locales';
import { legalTextState, type LegalTextState } from './markers';

export {
  isPlaceholder,
  legalTextState,
  PLACEHOLDER_MARKER,
  unfilledMarkers,
  type LegalTextState,
} from './markers';

// Phase 18 §3 — the public legal pages (/legal/<doc>) render operator-supplied Markdown from
// content/legal/<locale>/<doc>.md, falling back to en-GB with a "not translated" note. The files
// shipped in the repository are drafts (Phase 20.4) with fill-in markers such as
// [[COMPANY LEGAL NAME]] (markers.ts). The page shows a banner while a marker or the old
// PLACEHOLDER_MARKER is there, and the launch gate (readiness.ts) refuses to open production
// sign-up until terms and privacy are finished.

export const LEGAL_DOCS = [
  'terms',
  'privacy',
  'cookies',
  'acceptable-use',
  'dpa',
  'subprocessors',
] as const;

export type LegalDoc = (typeof LEGAL_DOCS)[number];

/** Where the Markdown lives (overridable for tests and for a mounted volume on the VPS). */
export function legalContentDir(env: Record<string, string | undefined> = process.env): string {
  return env.STUDIO_LEGAL_CONTENT_DIR?.trim() || join(process.cwd(), 'content', 'legal');
}

export function isLegalDoc(value: string): value is LegalDoc {
  return (LEGAL_DOCS as readonly string[]).includes(value);
}

export interface LegalDocument {
  doc: LegalDoc;
  markdown: string;
  /** The locale the text is actually in (en-GB when the reader's locale has no file). */
  locale: Locale;
  /** True when the reader's locale had no file and en-GB is shown instead. */
  fallback: boolean;
  /** True while the text is unfinished: the repository placeholder or a draft with markers. */
  placeholder: boolean;
  /** Which: 'placeholder' (replace the file), 'fill_in' (fill in the markers) or 'ready'. */
  state: LegalTextState;
}

function toDocument(
  doc: LegalDoc,
  markdown: string,
  locale: Locale,
  fallback: boolean,
): LegalDocument {
  const state = legalTextState(markdown);
  return { doc, markdown, locale, fallback, placeholder: state !== 'ready', state };
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * The document in the reader's locale, else en-GB. Returns null only when even the en-GB file is
 * missing (a broken deployment); the page then answers 404.
 */
export async function readLegalDocument(
  doc: LegalDoc,
  locale: string,
  dir: string = legalContentDir(),
): Promise<LegalDocument | null> {
  const wanted = (LOCALES as readonly string[]).includes(locale) ? (locale as Locale) : null;
  if (wanted && wanted !== DEFAULT_LOCALE) {
    const own = await readIfPresent(join(dir, wanted, `${doc}.md`));
    if (own !== null) return toDocument(doc, own, wanted, false);
  }
  const base = await readIfPresent(join(dir, DEFAULT_LOCALE, `${doc}.md`));
  if (base === null) return null;
  return toDocument(doc, base, DEFAULT_LOCALE, wanted !== null && wanted !== DEFAULT_LOCALE);
}
