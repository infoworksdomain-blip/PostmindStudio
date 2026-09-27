import { ValidationError } from '../../errors';
import { isS3Url, parseS3Url } from './corpus-source';

// BACKLOG 9.2 / 9.3 — the corpus manifest for scripts/ops/ingest-corpus.ts, kept free of I/O so
// it is unit tested: parse (CSV or JSONL), validate, sample, and track progress in a resumable
// state file. The server re-validates every item (services/library.ts adminIngestInput).

export const MAX_BATCH = 100;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 60;
const MAX_TITLE = 200;
const MAX_REF = 200;
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export interface ManifestRow {
  /** 1-based line (CSV: data row after the header) for error messages. */
  line: number;
  url: string;
  title?: string;
  tags: string[];
  category?: string;
  sourceRef?: string;
  language?: string;
  sourcePlatform?: string;
}

export interface RowError {
  line: number;
  url?: string;
  error: string;
}

export type ManifestFormat = 'csv' | 'jsonl';

/** Header / key aliases → canonical field. */
const FIELD_ALIASES: Record<string, keyof Omit<ManifestRow, 'line' | 'tags'> | 'tags'> = {
  url: 'url',
  sourceurl: 'url',
  source_url: 'url',
  title: 'title',
  tags: 'tags',
  category: 'category',
  categoryslug: 'category',
  category_slug: 'category',
  sourceref: 'sourceRef',
  source_ref: 'sourceRef',
  externalid: 'sourceRef',
  external_id: 'sourceRef',
  id: 'sourceRef',
  language: 'language',
  lang: 'language',
  sourceplatform: 'sourcePlatform',
  source_platform: 'sourcePlatform',
  platform: 'sourcePlatform',
};

export function formatFromPath(path: string): ManifestFormat {
  if (/\.csv$/i.test(path)) return 'csv';
  if (/\.(jsonl|ndjson)$/i.test(path)) return 'jsonl';
  throw new ValidationError('Manifest must be a .csv or .jsonl file');
}

/** RFC 4180 CSV: quoted fields may hold commas, newlines and "" escapes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i] as string;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (quoted) throw new ValidationError('CSV has an unterminated quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function splitTags(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value.map(String)
    : typeof value === 'string'
      ? value.split(/[|;]/)
      : [];
  return list.map((t) => t.trim()).filter(Boolean);
}

function toRow(line: number, record: Record<string, unknown>): ManifestRow {
  const row: ManifestRow = { line, url: '', tags: [] };
  for (const [key, value] of Object.entries(record)) {
    const field = FIELD_ALIASES[key.trim().toLowerCase()];
    if (!field || value === null || value === undefined) continue;
    if (field === 'tags') row.tags = splitTags(value);
    else {
      const text = String(value).trim();
      if (text) row[field] = text;
    }
  }
  return row;
}

/** Parses the manifest; malformed lines are reported, never silently dropped. */
export function parseManifest(
  text: string,
  format: ManifestFormat,
): { rows: ManifestRow[]; errors: RowError[] } {
  const rows: ManifestRow[] = [];
  const errors: RowError[] = [];
  if (format === 'csv') {
    const [header, ...data] = parseCsv(text);
    if (!header) throw new ValidationError('Manifest is empty');
    const keys = header.map((h) => h.trim());
    if (!keys.some((k) => FIELD_ALIASES[k.toLowerCase()] === 'url'))
      throw new ValidationError('CSV header needs a "url" column');
    data.forEach((cells, index) => {
      if (cells.length > keys.length)
        errors.push({
          line: index + 2,
          error: `has ${cells.length} fields, header has ${keys.length}`,
        });
      else rows.push(toRow(index + 2, Object.fromEntries(keys.map((k, i) => [k, cells[i]]))));
    });
    return { rows, errors };
  }
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        errors.push({ line: index + 1, error: 'not a JSON object' });
      else rows.push(toRow(index + 1, parsed as Record<string, unknown>));
    } catch {
      errors.push({ line: index + 1, error: 'invalid JSON' });
    }
  });
  return { rows, errors };
}

/** Why a URL can't be a corpus source (the tool accepts https:// and s3:// only). */
export function urlProblem(raw: string): string | null {
  if (isS3Url(raw)) {
    try {
      parseS3Url(raw);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : 'invalid s3:// URL';
    }
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (url.protocol !== 'https:') return 'only https:// and s3:// sources are accepted';
  if (url.username || url.password) return 'URLs with credentials are refused';
  if (raw.length > 2_000) return 'URL is longer than 2000 characters';
  return null;
}

function rowProblem(row: ManifestRow, categories: ReadonlySet<string>): string | null {
  if (!row.url) return 'missing url';
  const bad = urlProblem(row.url);
  if (bad) return bad;
  if (row.category && !categories.has(row.category))
    return `unknown category slug "${row.category}"`;
  if (row.tags.length > MAX_TAGS) return `more than ${MAX_TAGS} tags`;
  if (row.tags.some((t) => t.length > MAX_TAG_LEN)) return `a tag is longer than ${MAX_TAG_LEN}`;
  if (row.title && row.title.length > MAX_TITLE) return `title is longer than ${MAX_TITLE}`;
  if (row.sourceRef && row.sourceRef.length > MAX_REF) return `sourceRef is longer than ${MAX_REF}`;
  if (row.language && !LANGUAGE.test(row.language))
    return `language "${row.language}" is not a code such as en or pt-BR`;
  if (row.sourcePlatform && row.sourcePlatform.length > 40) return 'sourcePlatform is too long';
  return null;
}

/** Scheme, duplicates (url and sourceRef), category slugs (from GET /library/categories), sizes. */
export function validateRows(
  rows: ManifestRow[],
  categories: ReadonlySet<string>,
): { valid: ManifestRow[]; errors: RowError[] } {
  const valid: ManifestRow[] = [];
  const errors: RowError[] = [];
  const urls = new Map<string, number>();
  const refs = new Map<string, number>();
  for (const row of rows) {
    const problem = rowProblem(row, categories);
    const dupUrl = urls.get(row.url);
    const dupRef = row.sourceRef ? refs.get(row.sourceRef) : undefined;
    const error =
      problem ??
      (dupUrl !== undefined ? `duplicate of line ${dupUrl}` : null) ??
      (dupRef !== undefined ? `sourceRef duplicates line ${dupRef}` : null);
    if (error) {
      errors.push({ line: row.line, url: row.url || undefined, error });
      continue;
    }
    urls.set(row.url, row.line);
    if (row.sourceRef) refs.set(row.sourceRef, row.line);
    valid.push(row);
  }
  return { valid, errors };
}

/** Flattens GET /library/categories' tree into its slugs. */
export function categorySlugsFromTree(
  nodes: ReadonlyArray<{ slug: string; children?: unknown }>,
): Set<string> {
  const out = new Set<string>();
  const walk = (list: ReadonlyArray<{ slug: string; children?: unknown }>) => {
    for (const node of list) {
      out.add(node.slug);
      if (Array.isArray(node.children)) walk(node.children as typeof list);
    }
  };
  walk(nodes);
  return out;
}

/** Deterministic PRNG (mulberry32) so a sample can be reproduced with --seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export const AUTO_CATEGORY = '(auto)';

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * Stratified random sample: every category (top-level slug segment; rows without a category are
 * one "(auto)" stratum) gets a share proportional to its size, at least one while n allows.
 */
export function stratifiedSample(
  rows: readonly ManifestRow[],
  n: number,
  random: () => number,
): ManifestRow[] {
  if (n >= rows.length) return [...rows];
  const strata = new Map<string, ManifestRow[]>();
  for (const row of rows) {
    const key = row.category?.split('/')[0] ?? AUTO_CATEGORY;
    strata.set(key, [...(strata.get(key) ?? []), row]);
  }
  const groups = [...strata.entries()].sort(([a], [b]) => a.localeCompare(b));
  const quota = new Map(
    groups.map(([key, list]) => [key, Math.floor((list.length / rows.length) * n)]),
  );
  let left = n - [...quota.values()].reduce((a, b) => a + b, 0);
  // Give remaining slots to the largest strata first, starting with any that got none.
  const order = [...groups].sort(
    ([ka, a], [kb, b]) => (quota.get(ka) ?? 0) - (quota.get(kb) ?? 0) || b.length - a.length,
  );
  for (let i = 0; left > 0; i = (i + 1) % order.length) {
    const [key, list] = order[i] as [string, ManifestRow[]];
    if ((quota.get(key) ?? 0) < list.length) {
      quota.set(key, (quota.get(key) ?? 0) + 1);
      left -= 1;
    }
  }
  const picked = groups.flatMap(([key, list]) =>
    shuffle(list, random).slice(0, quota.get(key) ?? 0),
  );
  return picked.sort((a, b) => a.line - b.line);
}

export function chunk<T>(items: readonly T[], size = MAX_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function categoryDistribution(
  rows: ReadonlyArray<{ category?: string | null }>,
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.category?.split('/')[0] ?? AUTO_CATEGORY;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ---------------------------------------------------------------- state file

export type RowStatus = 'accepted' | 'skipped' | 'rejected';

export interface RowState {
  status: RowStatus;
  runId?: string;
  jobId?: string;
  /** Existing run state when the server skipped the row (already ingested). */
  serverState?: string;
  libraryItemId?: string | null;
  error?: string;
  sample?: boolean;
  at: string;
}

export interface CorpusState {
  version: 1;
  manifest: string;
  /** Keyed by source URL. */
  rows: Record<string, RowState>;
}

export function emptyState(manifest: string): CorpusState {
  return { version: 1, manifest, rows: {} };
}

/** Accepts a parsed state file, or throws when it isn't one of ours. */
export function loadState(raw: unknown, manifest: string): CorpusState {
  const s = raw as Partial<CorpusState> | null;
  if (!s || s.version !== 1 || typeof s.rows !== 'object' || s.rows === null)
    throw new ValidationError('State file is not an ingest-corpus state file (version 1)');
  return { version: 1, manifest: s.manifest ?? manifest, rows: { ...s.rows } };
}

/** Rows still to submit: never accepted or skipped (rejected submissions are retried). */
export function pendingRows(rows: readonly ManifestRow[], state: CorpusState): ManifestRow[] {
  return rows.filter((r) => {
    const s = state.rows[r.url]?.status;
    return s !== 'accepted' && s !== 'skipped';
  });
}

export function withRowStates(state: CorpusState, updates: Record<string, RowState>): CorpusState {
  return { ...state, rows: { ...state.rows, ...updates } };
}

export function stateCounts(state: CorpusState): Record<RowStatus, number> {
  const counts: Record<RowStatus, number> = { accepted: 0, skipped: 0, rejected: 0 };
  for (const row of Object.values(state.rows)) counts[row.status] += 1;
  return counts;
}
