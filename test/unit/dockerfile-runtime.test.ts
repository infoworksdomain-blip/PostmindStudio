import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// The runtime image runs web, worker and the ops scripts straight from the source tree (tsx), so
// every top-level folder that non-test code imports must be copied into the runtime stage. The
// first server shipped without messages/ and every email failed (2026-09-30).

const ROOT = join(__dirname, '..', '..');
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const runtimeStage = dockerfile.slice(dockerfile.indexOf(' AS runtime'));
const copied = new Set(
  [...runtimeStage.matchAll(/^COPY --from=build\s+(?:--chown=\S+\s+)?(.+)$/gm)].flatMap((m) =>
    m[1]!
      .split(/\s+/)
      .slice(0, -1)
      .map((src) => src.replace(/^\/app\//, '').split('/')[0]!),
  ),
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Top-level folders reached by relative imports from non-test code under src/ and scripts/. */
function importedTopLevelFolders(): Set<string> {
  const folders = new Set<string>();
  for (const file of [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'scripts'))]) {
    const text = readFileSync(file, 'utf8');
    for (const [, spec] of text.matchAll(/(?:from|import\()\s*'(\.{1,2}\/[^']+)'/g)) {
      const target = relative(ROOT, join(file, '..', spec!));
      const top = target.split(sep)[0]!;
      if (top && top !== '..' && !top.includes('.')) folders.add(top);
    }
  }
  return folders;
}

const TOP_LEVEL_DIRS = new Set(
  readdirSync(ROOT).filter(
    (name) =>
      !name.startsWith('.') && name !== 'node_modules' && statSync(join(ROOT, name)).isDirectory(),
  ),
);

/**
 * Folders the running app reaches by path at runtime rather than by import: `join(process.cwd(),
 * 'content', …)`, `join(root, 'content')`, or a path literal such as `'infra/s3-lifecycle.json'`.
 * A missing folder there only fails when the code path runs (the legal pages, an email), which is
 * how messages/ slipped through the import check.
 */
function scanRuntimePathFolders(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (folder: string, file: string) => {
    if (!TOP_LEVEL_DIRS.has(folder)) return;
    found.set(folder, [...(found.get(folder) ?? []), relative(ROOT, file).split(sep).join('/')]);
  };
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const [, folder] of text.matchAll(
      /(?:join|resolve)\((?:\(\)|[^)])*?['`]([a-z][\w-]*)['`]/g,
    )) {
      add(folder!, file);
    }
    for (const [, folder] of text.matchAll(/['`]([a-z][\w-]*)\/[\w.\-/]+['`]/g)) {
      add(folder!, file);
    }
  }
  return found;
}

/**
 * Path-read folders that are deliberately not in the image, each with where the code actually
 * runs. Anything new must be copied by the Dockerfile or added here with a reason.
 */
const RUNTIME_PATH_FOLDERS = scanRuntimePathFolders();
const runtimePathFolders = () => RUNTIME_PATH_FOLDERS;

const NOT_IN_IMAGE: Record<string, string> = {
  deploy: 'setup:env / setup:check run on the operator host checkout (runbooks/vps-deploy.md)',
  infra: 'apply-s3-lifecycle runs from the operator machine, not the app container',
  ops: 'ops/results is a volume mounted by the ops service; ops/render is read by CI only',
  'load-test': 'the k6 staging-gate check runs where k6 is installed, not in the app image',
};

describe('Dockerfile runtime stage', () => {
  it('copies messages/ (email and UI catalogues)', () => {
    expect(copied.has('messages')).toBe(true);
  });

  it('copies every top-level folder that non-test code imports', () => {
    const missing = [...importedTopLevelFolders()].filter((f) => !copied.has(f));
    expect(missing).toEqual([]);
  });

  it('copies every folder the app reads by path at runtime (process.cwd(), path literals)', () => {
    const missing = [...runtimePathFolders()]
      .filter(([folder]) => !copied.has(folder) && !(folder in NOT_IN_IMAGE))
      .map(([folder, files]) => `${folder}/ (read in ${[...new Set(files)].join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('reads the legal Markdown from content/, which the image copies', () => {
    expect(runtimePathFolders().get('content')).toBeDefined();
    expect(copied.has('content')).toBe(true);
  });

  it('keeps the not-in-image list honest (every entry is still read by path somewhere)', () => {
    const read = runtimePathFolders();
    expect(Object.keys(NOT_IN_IMAGE).filter((f) => !read.has(f))).toEqual([]);
  });
});
