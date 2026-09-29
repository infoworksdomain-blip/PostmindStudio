// Phase 18 — merge message keys into every messages/<locale>.json at the LEAF level. Several
// agents edit the catalogues in parallel, so nothing here replaces a namespace: existing keys keep
// their value and position, new keys are appended where they belong, and a leaf that already
// exists with a different value is only overwritten with --overwrite.
//
//   npx tsx scripts/i18n/merge-keys.ts <fragments-dir> [--overwrite]
//
// <fragments-dir>/<locale>.json holds a partial catalogue for that locale, e.g.
//   { "errors": { "codes": { "plan_required": "…" } }, "auth": { "signIn": { "title": "…" } } }
// An empty object creates the namespace (or sub-object) when it is missing. Every locale in
// LOCALES must have a fragment, so no locale is forgotten. Run review-list.ts afterwards.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES } from '../../src/lib/i18n/locales';
import { MESSAGES_DIR } from './catalogues';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface MergeResult {
  added: string[];
  changed: string[];
  conflicts: string[];
}

/** Deep-merge `patch` into `target` (mutates `target`); returns what was added or changed. */
export function mergeLeaves(
  target: JsonObject,
  patch: JsonObject,
  options: { overwrite?: boolean } = {},
  prefix = '',
  result: MergeResult = { added: [], changed: [], conflicts: [] },
): MergeResult {
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const current = target[key];
    if (isObject(value)) {
      if (current === undefined) {
        target[key] = {};
        if (Object.keys(value).length === 0) result.added.push(path);
      } else if (!isObject(current)) {
        result.conflicts.push(`${path} (a message, not an object)`);
        continue;
      }
      mergeLeaves(target[key] as JsonObject, value, options, path, result);
      continue;
    }
    if (current === undefined) {
      target[key] = value;
      result.added.push(path);
    } else if (isObject(current)) {
      result.conflicts.push(`${path} (an object, not a message)`);
    } else if (current !== value) {
      if (options.overwrite) {
        target[key] = value;
        result.changed.push(path);
      } else {
        result.conflicts.push(`${path} (differs; pass --overwrite to replace)`);
      }
    }
  }
  return result;
}

function main(): void {
  const [dirArg, ...flags] = process.argv.slice(2);
  if (!dirArg) {
    process.stderr.write('usage: merge-keys.ts <fragments-dir> [--overwrite]\n');
    process.exit(2);
  }
  const dir = resolve(dirArg);
  const overwrite = flags.includes('--overwrite');
  const missing = LOCALES.filter((l) => !existsSync(join(dir, `${l}.json`)));
  if (missing.length > 0) {
    process.stderr.write(`no fragment for: ${missing.join(', ')}\n`);
    process.exit(1);
  }
  let conflicts = 0;
  for (const locale of LOCALES) {
    const patch = JSON.parse(readFileSync(join(dir, `${locale}.json`), 'utf8')) as Json;
    if (!isObject(patch)) throw new Error(`${locale}.json is not a JSON object`);
    const file = join(MESSAGES_DIR, `${locale}.json`);
    // Read immediately before writing: another agent may have written the file meanwhile.
    const catalogue = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
    const result = mergeLeaves(catalogue, patch, { overwrite });
    writeFileSync(file, `${JSON.stringify(catalogue, null, 2)}\n`);
    conflicts += result.conflicts.length;
    process.stdout.write(
      `${locale}: ${result.added.length} added, ${result.changed.length} changed` +
        (result.conflicts.length ? `, CONFLICTS: ${result.conflicts.join('; ')}` : '') +
        '\n',
    );
  }
  if (conflicts > 0) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
