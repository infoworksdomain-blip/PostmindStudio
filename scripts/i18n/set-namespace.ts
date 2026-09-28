// BACKLOG 16.1 — writes one area's namespace(s) into every messages/<locale>.json without touching
// the rest of the catalogue (four area agents share these files).
//
//   npx tsx scripts/i18n/set-namespace.ts <fragments-dir>
//
// <fragments-dir>/<locale>/<path>.json holds the object for <path>: `library.json` is the whole
// `library` namespace, `admin.beta.json` is `admin.beta`. Fragments of one namespace are merged
// (the bare namespace file first, then sub-paths in name order). For each locale the CURRENT file
// is read from disk immediately before writing, and only the top-level namespaces that have
// fragments are replaced; every other key keeps its value and position.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LOCALES } from '../../src/lib/i18n/locales';
import { MESSAGES_DIR } from './catalogues';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setPath(target: JsonObject, path: string[], value: JsonObject): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  if (rest.length === 0) {
    target[head] = value;
    return;
  }
  const next = target[head];
  const child: JsonObject = isObject(next) ? next : {};
  target[head] = child;
  setPath(child, rest, value);
}

function buildNamespaces(dir: string): Map<string, JsonObject> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    // Bare namespace first, then deeper paths, then name order: deterministic key order.
    .sort((a, b) => a.split('.').length - b.split('.').length || a.localeCompare(b));
  const namespaces = new Map<string, JsonObject>();
  for (const name of files) {
    const value = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as Json;
    if (!isObject(value)) throw new Error(`${dir}/${name}.json is not a JSON object`);
    const [ns, ...rest] = name.split('.');
    if (!ns) continue;
    const root = namespaces.get(ns) ?? {};
    if (rest.length === 0) Object.assign(root, value);
    else setPath(root, rest, value);
    namespaces.set(ns, root);
  }
  return namespaces;
}

const fragmentsDir = process.argv[2];
if (!fragmentsDir) {
  process.stderr.write('usage: npx tsx scripts/i18n/set-namespace.ts <fragments-dir>\n');
  process.exit(1);
}

for (const locale of LOCALES) {
  const dir = resolve(fragmentsDir, locale);
  if (!existsSync(dir)) {
    process.stderr.write(`${locale}: no fragments in ${dir}\n`);
    process.exitCode = 1;
    continue;
  }
  const namespaces = buildNamespaces(dir);
  const file = join(MESSAGES_DIR, `${locale}.json`);
  const current = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  const next: JsonObject = {};
  for (const [key, value] of Object.entries(current)) next[key] = namespaces.get(key) ?? value;
  for (const [key, value] of namespaces) if (!(key in next)) next[key] = value;
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(`${locale}: ${[...namespaces.keys()].join(', ')}\n`);
}
