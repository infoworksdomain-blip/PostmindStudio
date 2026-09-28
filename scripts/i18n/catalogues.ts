import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Catalogue, ReviewList } from '../../src/lib/i18n/catalogue-check';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '../../src/lib/i18n/locales';

// Reads messages/<locale>.json and messages/<locale>.review.json from disk (BACKLOG 16.4).

export const MESSAGES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'messages',
);

export const TRANSLATED_LOCALES: readonly Locale[] = LOCALES.filter((l) => l !== DEFAULT_LOCALE);

export function readCatalogue(locale: Locale, dir = MESSAGES_DIR): Catalogue {
  return JSON.parse(readFileSync(join(dir, `${locale}.json`), 'utf8')) as Catalogue;
}

export function reviewPath(locale: Locale, dir = MESSAGES_DIR): string {
  return join(dir, `${locale}.review.json`);
}

export function readReviewList(locale: Locale, dir = MESSAGES_DIR): ReviewList | undefined {
  const path = reviewPath(locale, dir);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ReviewList) : undefined;
}
