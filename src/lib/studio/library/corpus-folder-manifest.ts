import { createHash } from 'node:crypto';
import { flattenTaxonomy, slugPart, type TaxonomyNode } from './taxonomy';
import type { FolderFile } from './corpus-folder';

// Phase 19 Track 1 — turns a folder of videos into rows of corpus/manifest.template.csv
// (scripts/corpus/manifest-from-folder.ts). Pure; unit tested.

/** Exactly the template's header (corpus/manifest.template.csv). */
export const MANIFEST_COLUMNS = [
  'url',
  'title',
  'tags',
  'category',
  'sourceRef',
  'language',
  'sourcePlatform',
] as const;

export interface FolderManifestRow {
  url: string;
  title: string;
  tags: string[];
  category: string;
  sourceRef: string;
  language: string;
  sourcePlatform: string;
}

const MAX_TITLE = 200;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 60;

function stripAccents(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '');
}

function baseName(relPath: string): string {
  const name = relPath.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * File name → title: extension removed, underscores and dashes become spaces, sentence case
 * (first letter upper case, the rest lower case except all-capital words such as "UK" or "DIY").
 */
export function titleFromFileName(relPath: string): string {
  const words = baseName(relPath)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const cased = words.map((w, i) => {
    const keep = w.length > 1 && w === w.toUpperCase() && w !== w.toLowerCase();
    const lower = keep ? w : w.toLowerCase();
    return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
  });
  return cased.join(' ').slice(0, MAX_TITLE).trim();
}

/** "Behind The Scenes!" → "behind-the-scenes"; letters of any script are kept. */
export function kebabCase(text: string): string {
  return stripAccents(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** Tags from the parent folder names: kebab-cased, de-duplicated, 20 at most, 60 chars each. */
export function tagsFromPath(relPath: string): string[] {
  const folders = relPath.split('/').slice(0, -1);
  const tags: string[] = [];
  for (const folder of folders) {
    const tag = kebabCase(folder).slice(0, MAX_TAG_LEN).replace(/-+$/, '');
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, MAX_TAGS);
}

export interface CategoryIndex {
  slugs: Set<string>;
  /** Last slug segment → full slugs (to match a folder named after a sub-category). */
  byLeaf: Map<string, string[]>;
}

export function categoryIndex(nodes: TaxonomyNode[]): CategoryIndex {
  const flat = flattenTaxonomy(nodes);
  const byLeaf = new Map<string, string[]>();
  for (const c of flat) {
    const leaf = c.slug.split('/').pop() as string;
    byLeaf.set(leaf, [...(byLeaf.get(leaf) ?? []), c.slug]);
  }
  return { slugs: new Set(flat.map((c) => c.slug)), byLeaf };
}

/**
 * The top-level folder picks the category when it names one (a top-level category, or a
 * sub-category whose name is unique); a second-level folder naming a child narrows it.
 * Otherwise '' so Claude classifies the video at ingest.
 */
export function categoryFromPath(relPath: string, index: CategoryIndex): string {
  const folders = relPath.split('/').slice(0, -1);
  const top = folders[0];
  if (top === undefined) return '';
  const topSlug = slugPart(top);
  let category = '';
  if (index.slugs.has(topSlug)) category = topSlug;
  else {
    const leaves = index.byLeaf.get(topSlug) ?? [];
    if (leaves.length === 1) category = leaves[0] as string;
  }
  if (!category) return '';
  const second = folders[1];
  const child = second === undefined ? '' : `${category}/${slugPart(second)}`;
  return child && index.slugs.has(child) ? child : category;
}

/** Language names (accent-free, lower case) and codes that clearly name a language. */
const LANGUAGE_NAMES: Record<string, string> = {
  english: 'en',
  french: 'fr',
  francais: 'fr',
  spanish: 'es',
  espanol: 'es',
  german: 'de',
  deutsch: 'de',
  italian: 'it',
  italiano: 'it',
  portuguese: 'pt',
  portugues: 'pt',
  brazilian: 'pt-BR',
  arabic: 'ar',
  hindi: 'hi',
  chinese: 'zh',
  mandarin: 'zh',
  swahili: 'sw',
  kiswahili: 'sw',
  yoruba: 'yo',
  hausa: 'ha',
  igbo: 'ig',
  zulu: 'zu',
  amharic: 'am',
  dutch: 'nl',
  polish: 'pl',
  russian: 'ru',
  turkish: 'tr',
  japanese: 'ja',
  korean: 'ko',
  urdu: 'ur',
  bengali: 'bn',
};
/** Codes accepted when a whole folder name is the code (Studio's locales plus a few more). */
const LANGUAGE_CODES = [
  'en',
  'en-GB',
  'en-US',
  'fr',
  'es',
  'de',
  'it',
  'pt',
  'pt-BR',
  'pt-PT',
  'ar',
  'hi',
  'zh',
  'zh-Hans',
  'sw',
  'yo',
  'ha',
  'ig',
  'zu',
];
const CODE_BY_LOWER = new Map(LANGUAGE_CODES.map((c) => [c.toLowerCase(), c]));

function languageOfLabel(label: string): string | undefined {
  const plain = stripAccents(label).trim().toLowerCase();
  return LANGUAGE_NAMES[plain] ?? CODE_BY_LOWER.get(plain.replace(/_/g, '-'));
}

/**
 * Only when the path says so clearly: a folder whose whole name is a language ("French", "fr",
 * "pt-BR"), or a bracketed label in the file name ("… (Spanish).mp4", "… [en].mp4"). Words
 * inside names ("French toast") never count. Conflicting signals → ''.
 */
export function languageFromPath(relPath: string): string {
  const folders = relPath.split('/').slice(0, -1);
  const found = new Set<string>();
  for (const folder of folders) {
    const lang = languageOfLabel(folder);
    if (lang) found.add(lang);
  }
  for (const match of baseName(relPath).matchAll(/[([]([^()[\]]{2,20})[)\]]/g)) {
    const lang = languageOfLabel(match[1] as string);
    if (lang) found.add(lang);
  }
  return found.size === 1 ? ([...found][0] as string) : '';
}

const PLATFORMS = [
  'tiktok',
  'instagram',
  'youtube',
  'facebook',
  'snapchat',
  'linkedin',
  'pinterest',
  'twitter',
] as const;

/** sourcePlatform when the path names exactly one platform (tiktok, instagram, youtube, …). */
export function platformFromPath(relPath: string): string {
  const lower = stripAccents(relPath)
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  const found = PLATFORMS.filter((p) => lower.includes(p));
  return found.length === 1 ? (found[0] as string) : '';
}

/** Stable id for a file: the same relative path always gives the same sourceRef. */
export function sourceRefFor(relPath: string): string {
  return `corpus-${createHash('sha256').update(relPath, 'utf8').digest('hex').slice(0, 20)}`;
}

export function s3UrlFor(bucket: string, prefix: string, relPath: string): string {
  return `s3://${bucket}/${prefix}${relPath}`;
}

export function manifestRow(
  file: FolderFile,
  options: { bucket: string; prefix: string; categories: CategoryIndex },
): FolderManifestRow {
  return {
    url: s3UrlFor(options.bucket, options.prefix, file.relPath),
    title: titleFromFileName(file.relPath),
    tags: tagsFromPath(file.relPath),
    category: categoryFromPath(file.relPath, options.categories),
    sourceRef: sourceRefFor(file.relPath),
    language: languageFromPath(file.relPath),
    sourcePlatform: platformFromPath(file.relPath),
  };
}

/** RFC 4180 quoting: fields with a comma, quote, line break or edge space are quoted. */
export function csvField(value: string): string {
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function manifestCsv(rows: readonly FolderManifestRow[]): string {
  const lines = [MANIFEST_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(
      MANIFEST_COLUMNS.map((col) => csvField(col === 'tags' ? row.tags.join('|') : row[col])).join(
        ',',
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}
