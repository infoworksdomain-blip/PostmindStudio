// BACKLOG 16.2 — lists Tailwind classes tied to a physical side (ml-/mr-/pl-/pr-/left-/right-/
// text-left/text-right/border-l/r/rounded-l/r) in src/components/studio/**, with the logical
// replacement. Informational during Phase 16 (area agents convert their own screens):
//
//   npx tsx scripts/i18n/check-physical-css.ts            → report, exit 0
//   npx tsx scripts/i18n/check-physical-css.ts --fail     → exit 1 when anything is found
//
// At the end of Phase 16 the --fail form becomes a CI check. A deliberate physical class (e.g. the
// overlay timeline, which keeps time running left to right in every locale) is exempted by a
// `i18n-physical-ok` comment on the same line.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPhysicalClasses } from '../../src/lib/i18n/physical-css';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const target = join(root, 'src', 'components', 'studio');
const fail = process.argv.includes('--fail');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

let total = 0;
const perFile: Array<[string, number]> = [];
for (const file of files(target)) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const hits = findPhysicalClasses(source).filter(
    (h) => !lines[h.line - 1]?.includes('i18n-physical-ok'),
  );
  if (hits.length === 0) continue;
  const rel = relative(root, file).replace(/\\/g, '/');
  perFile.push([rel, hits.length]);
  total += hits.length;
  for (const h of hits) {
    process.stdout.write(`${rel}:${h.line}:${h.column}  ${h.token} → ${h.suggestion}\n`);
  }
}

process.stdout.write(
  total
    ? `\n${total} physical class(es) in ${perFile.length} file(s)${fail ? '' : ' (informational)'}\n`
    : 'no physical left/right classes in src/components/studio\n',
);
process.exit(fail && total > 0 ? 1 : 0);
