import { UPLOAD_VIDEO_EXTENSION } from '../services/uploads';
import { MAX_SOURCE_BYTES } from './ingest';

// Phase 19 Track 1 — the rules shared by scripts/corpus/scan-folder.ts and
// manifest-from-folder.ts (runbooks/corpus-upload.md). Pure, so both tools agree on exactly which
// files are uploaded and listed, and the rules are unit tested.
//
// What the ingest itself refuses (library/ingest.ts): a source larger than MAX_SOURCE_BYTES
// (200 MiB) and an empty object. It does not check the extension: FFmpeg probes the bytes and a
// non-video fails with "Source has no video duration". The accepted formats are therefore the
// ones Studio's own video uploads accept (services/uploads.ts: mp4, mov, webm); others can be
// added per run with --also-accept after a sample proves FFmpeg reads them.

/** Studio's accepted video extensions, lower case, without the dot. */
export const DEFAULT_ACCEPTED_EXTENSIONS: readonly string[] = Object.values(UPLOAD_VIDEO_EXTENSION);

/** S3 / R2 object keys are at most 1,024 bytes of UTF-8. */
export const MAX_KEY_BYTES = 1_024;

export { MAX_SOURCE_BYTES };

export type RejectReason =
  'too-large' | 'empty' | 'unsupported-format' | 'system-file' | 'bad-name' | 'key-too-long';

export const REJECT_EXPLANATION: Record<RejectReason, string> = {
  'too-large': 'larger than 200 MB: the ingest refuses it ("Source video is larger than 200 MB")',
  empty: 'empty file (0 bytes): the ingest refuses it ("Source object is empty")',
  'unsupported-format':
    'not an accepted video format (mp4, mov, webm): FFmpeg would fail with "Source has no video duration"',
  'system-file': 'a system or hidden helper file, not a video',
  'bad-name':
    'the name has characters the upload tool would change, so the stored name would not match the manifest: rename it',
  'key-too-long': 'the path is longer than the 1,024 bytes a storage key may have: shorten it',
};

export interface FolderFile {
  /** Path relative to the scanned folder, segments joined with "/". */
  relPath: string;
  size: number;
}

export interface FileVerdict extends FolderFile {
  /** Lower-case extension without the dot ('' when there is none). */
  ext: string;
  reject: RejectReason[];
  /** Name issues that do not block the upload but are worth a look. */
  warnings: string[];
}

export function extensionOf(relPath: string): string {
  const name = relPath.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Characters rclone's local backend maps back to a different character when it reads a file
 * name (rclone.org/local/ "Restricted characters", read 2026-09-29): the full-width look-alikes
 * of " * : < > ? \ | / and the control-picture symbols U+2400–U+241F. A file named with one of
 * them would be stored under a different key than the manifest lists.
 */
const RCLONE_REMAPPED = /[＂＊：＜＞？＼｜／␀-␟]/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
const URL_AWKWARD = /[#%+&]/;
const SYSTEM_NAMES = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);

/** Name problems that make the upload store the file under a different key (so: reject). */
export function nameProblems(relPath: string): string[] {
  const problems: string[] = [];
  const segments = relPath.split('/');
  if (RCLONE_REMAPPED.test(relPath))
    problems.push('has a full-width or symbol character the upload tool would convert');
  if (CONTROL.test(relPath)) problems.push('has a control character');
  if (LONE_SURROGATE.test(relPath)) problems.push('is not valid Unicode');
  if (segments.some((s) => /[ .]$/.test(s))) problems.push('a name ends with a space or a dot');
  return problems;
}

/** Name issues worth reviewing that do not change the stored key. */
export function nameWarnings(relPath: string): string[] {
  const warnings: string[] = [];
  const segments = relPath.split('/');
  if (/[^\x20-\x7e]/.test(relPath)) warnings.push('non-English letters or symbols');
  if (URL_AWKWARD.test(relPath)) warnings.push('contains # % + or &');
  if (segments.some((s) => /^\s/.test(s) || /\s{2,}/.test(s)))
    warnings.push('leading or double spaces');
  return warnings;
}

function isSystemFile(relPath: string): boolean {
  const name = (relPath.split('/').pop() ?? '').toLowerCase();
  return SYSTEM_NAMES.has(name) || name.startsWith('._') || name.startsWith('~$');
}

export function classifyFile(
  file: FolderFile,
  options: { accepted: ReadonlySet<string>; keyPrefix?: string },
): FileVerdict {
  const ext = extensionOf(file.relPath);
  const reject: RejectReason[] = [];
  if (isSystemFile(file.relPath)) reject.push('system-file');
  else if (!options.accepted.has(ext)) reject.push('unsupported-format');
  if (file.size === 0) reject.push('empty');
  if (file.size > MAX_SOURCE_BYTES) reject.push('too-large');
  if (nameProblems(file.relPath).length > 0) reject.push('bad-name');
  const key = `${options.keyPrefix ?? ''}${file.relPath}`;
  if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) reject.push('key-too-long');
  return { ...file, ext, reject, warnings: nameWarnings(file.relPath) };
}

/** `--also-accept mkv,m4v` → the accepted set (defaults plus the extras, lower case). */
export function acceptedExtensions(extra: readonly string[] = []): Set<string> {
  return new Set([
    ...DEFAULT_ACCEPTED_EXTENSIONS,
    ...extra.map((e) => e.trim().replace(/^\./, '').toLowerCase()).filter(Boolean),
  ]);
}

/** "videos" / "/videos/" / "" → "videos/" / "videos/" / "" (the key prefix under the bucket). */
export function normalisePrefix(prefix: string): string {
  const trimmed = prefix
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  return trimmed ? `${trimmed}/` : '';
}

// ------------------------------------------------------------------ duplicates

export interface HashedFile extends FolderFile {
  /** Hash of the size plus the first and last 1 MiB (quick, not a full content hash). */
  quickHash: string;
}

/** Paths whose size another file shares: only these need the quick hash. */
export function sizeCollisions(files: readonly FolderFile[]): FolderFile[] {
  const bySize = new Map<number, FolderFile[]>();
  for (const f of files) bySize.set(f.size, [...(bySize.get(f.size) ?? []), f]);
  return [...bySize.values()].filter((g) => g.length > 1).flat();
}

/** Groups of two or more files with the same size and quick hash, each sorted by path. */
export function duplicateGroups(files: readonly HashedFile[]): string[][] {
  const byKey = new Map<string, string[]>();
  for (const f of files) {
    const key = `${f.size}:${f.quickHash}`;
    byKey.set(key, [...(byKey.get(key) ?? []), f.relPath]);
  }
  return [...byKey.values()]
    .filter((g) => g.length > 1)
    .map((g) => [...g].sort())
    .sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
}

/** Every copy after the first (by path) of each duplicate group. */
export function laterCopies(groups: readonly string[][]): Set<string> {
  return new Set(groups.flatMap((g) => g.slice(1)));
}

/**
 * The files the upload copies and the manifest lists, in path order: accepted, and not a later
 * copy of a duplicate when skipDuplicates is set. Both tools call this, so they always agree.
 */
export function selectUploadFiles(
  verdicts: readonly FileVerdict[],
  options: { duplicates: readonly string[][]; skipDuplicates: boolean },
): FileVerdict[] {
  const skip = options.skipDuplicates ? laterCopies(options.duplicates) : new Set<string>();
  return verdicts
    .filter((v) => v.reject.length === 0 && !skip.has(v.relPath))
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

/** The rclone --files-from-raw list: one relative path per line, LF, no BOM. */
export function uploadListText(files: readonly FolderFile[]): string {
  return files.map((f) => `${f.relPath}\n`).join('');
}

export function parseUploadList(text: string): string[] {
  return text
    .replace(/^﻿/, '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l !== '');
}
