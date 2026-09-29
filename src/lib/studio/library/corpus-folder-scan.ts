import { createHash } from 'node:crypto';
import { open, opendir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  classifyFile,
  duplicateGroups,
  selectUploadFiles,
  sizeCollisions,
  type FileVerdict,
  type FolderFile,
  type HashedFile,
} from './corpus-folder';

// Phase 19 Track 1 — the read-only folder walk behind scripts/corpus/scan-folder.ts and
// manifest-from-folder.ts. Nothing here writes, moves or renames a file.

/** Folders Windows keeps at a drive's root: never corpus content. */
const SKIPPED_DIRS = new Set(['$recycle.bin', 'system volume information']);
const QUICK_HASH_BYTES = 1024 * 1024;

export interface WalkResult {
  files: FolderFile[];
  /** Paths not followed or not readable, with the reason. */
  skipped: Array<{ relPath: string; reason: string }>;
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Recursive walk; symbolic links and junctions are reported, never followed. */
export async function walkFolder(root: string): Promise<WalkResult> {
  const files: FolderFile[] = [];
  const skipped: WalkResult['skipped'] = [];
  const visit = async (dir: string, rel: string[]): Promise<void> => {
    let handle;
    try {
      handle = await opendir(dir);
    } catch (err) {
      skipped.push({ relPath: rel.join('/') || '.', reason: `cannot open folder: ${errMsg(err)}` });
      return;
    }
    const entries = [];
    for await (const entry of handle) entries.push(entry);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relPath = [...rel, entry.name].join('/');
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink())
        skipped.push({ relPath, reason: 'link or junction (not followed)' });
      else if (entry.isDirectory()) {
        if (rel.length === 0 && SKIPPED_DIRS.has(entry.name.toLowerCase()))
          skipped.push({ relPath, reason: 'Windows system folder' });
        else await visit(abs, [...rel, entry.name]);
      } else if (entry.isFile()) {
        try {
          files.push({ relPath, size: (await stat(abs)).size });
        } catch (err) {
          skipped.push({ relPath, reason: `cannot read: ${errMsg(err)}` });
        }
      } else skipped.push({ relPath, reason: 'not a regular file' });
    }
  };
  await visit(root, []);
  return { files, skipped };
}

/** SHA-256 of the size and the first and last 1 MiB (the whole file when it is 2 MiB or less). */
export async function quickHash(path: string, size: number): Promise<string> {
  const hash = createHash('sha256').update(`${size}:`);
  const handle = await open(path, 'r');
  try {
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      hash.update(buffer.subarray(0, bytesRead));
    };
    if (size <= 2 * QUICK_HASH_BYTES) await read(0, size);
    else {
      await read(0, QUICK_HASH_BYTES);
      await read(size - QUICK_HASH_BYTES, QUICK_HASH_BYTES);
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

export interface FolderScan {
  root: string;
  verdicts: FileVerdict[];
  skipped: WalkResult['skipped'];
  duplicates: string[][];
  /** Files the quick hash could not read (left out of duplicate detection). */
  hashErrors: Array<{ relPath: string; reason: string }>;
}

/** Walk, classify, and find duplicate content among files that share a size. */
export async function scanFolder(
  root: string,
  options: { accepted: ReadonlySet<string>; keyPrefix?: string },
): Promise<FolderScan> {
  const { files, skipped } = await walkFolder(root);
  const verdicts = files.map((f) => classifyFile(f, options));
  const hashed: HashedFile[] = [];
  const hashErrors: FolderScan['hashErrors'] = [];
  for (const f of sizeCollisions(files.filter((x) => x.size > 0))) {
    try {
      hashed.push({
        ...f,
        quickHash: await quickHash(join(root, ...f.relPath.split('/')), f.size),
      });
    } catch (err) {
      hashErrors.push({ relPath: f.relPath, reason: errMsg(err) });
    }
  }
  return { root, verdicts, skipped, duplicates: duplicateGroups(hashed), hashErrors };
}

export function uploadSelection(scan: FolderScan, skipDuplicates: boolean): FileVerdict[] {
  return selectUploadFiles(scan.verdicts, { duplicates: scan.duplicates, skipDuplicates });
}
