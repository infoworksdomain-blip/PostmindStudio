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

describe('Dockerfile runtime stage', () => {
  it('copies messages/ (email and UI catalogues)', () => {
    expect(copied.has('messages')).toBe(true);
  });

  it('copies every top-level folder that non-test code imports', () => {
    const missing = [...importedTopLevelFolders()].filter((f) => !copied.has(f));
    expect(missing).toEqual([]);
  });
});
