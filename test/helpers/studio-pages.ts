import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// BACKLOG 25.4 — "nothing fake is listed": a test helper that says whether a signed-in app path
// has a page (src/app/(studio)/<path>/page.tsx), matching [param] folders for dynamic parts.

export const STUDIO_APP_DIR = join(process.cwd(), 'src', 'app', '(studio)');

export function hasStudioPage(path: string): boolean {
  const parts = (path.split(/[?#]/)[0] ?? '').split('/').filter(Boolean);
  let dir = STUDIO_APP_DIR;
  for (const part of parts) {
    if (existsSync(join(dir, part))) {
      dir = join(dir, part);
      continue;
    }
    const dynamic = readdirSync(dir, { withFileTypes: true }).find(
      (e) => e.isDirectory() && /^\[.+\]$/.test(e.name),
    );
    if (!dynamic) return false;
    dir = join(dir, dynamic.name);
  }
  return existsSync(join(dir, 'page.tsx'));
}
