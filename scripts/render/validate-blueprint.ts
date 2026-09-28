import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { logger } from '../../src/lib/logger';
import {
  assertPinnedSchema,
  RENDER_SCHEMA_PATH,
  RENDER_SCHEMA_SHA256,
  RENDER_SCHEMA_URL,
  sha256Hex,
  validateBlueprint,
} from '../../src/lib/render/blueprint-schema';

// Phase 17.7 — validate render.yaml against Render's published Blueprint JSON Schema (the pinned
// copy in ops/render/render.yaml.schema.json; see src/lib/render/blueprint-schema.ts). CI runs it
// in the `verify` job:
//
//   npx tsx scripts/render/validate-blueprint.ts [render.yaml]
//   npx tsx scripts/render/validate-blueprint.ts --check-upstream   # has Render changed it?
//
// Exit 1 when render.yaml is invalid, the vendored schema is not the pinned file, or (with
// --check-upstream) the published schema differs from the pinned one. The schema covers field
// names, types and enums; the cross-checks against the code (env vars, workers, monitoring) are in
// test/unit/render-blueprint.test.ts. `render blueprints validate` (Render CLI) remains the
// authoritative check before a Blueprint sync.

const out = (line: string) => process.stdout.write(`${line}\n`);

async function checkUpstream(): Promise<boolean> {
  const res = await fetch(RENDER_SCHEMA_URL);
  if (!res.ok) {
    out(`Could not fetch ${RENDER_SCHEMA_URL}: HTTP ${res.status}`);
    return false;
  }
  const upstream = sha256Hex(await res.text());
  if (upstream === RENDER_SCHEMA_SHA256) {
    out(`Upstream schema unchanged (sha256 ${upstream}).`);
    return true;
  }
  out(`Upstream schema CHANGED: pinned ${RENDER_SCHEMA_SHA256}, published ${upstream}.`);
  out(`Download it to ${RENDER_SCHEMA_PATH} and update RENDER_SCHEMA_SHA256 in one commit.`);
  return false;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--check-upstream')) {
    if (!(await checkUpstream())) process.exitCode = 1;
    return;
  }
  const file = args.find((a) => !a.startsWith('--')) ?? 'render.yaml';
  const raw = readFileSync(resolve(RENDER_SCHEMA_PATH), 'utf8');
  assertPinnedSchema(raw);
  const problems = validateBlueprint(
    load(readFileSync(resolve(file), 'utf8')),
    JSON.parse(raw) as object,
  );
  if (problems.length === 0) {
    out(`${file} is valid against Render's Blueprint schema (${RENDER_SCHEMA_URL}).`);
    return;
  }
  out(`${file} does not match Render's Blueprint schema:`);
  for (const p of problems) out(`  ${p.path}: ${p.message}`);
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  logger.error({ err }, 'validate-blueprint failed');
  process.exitCode = 1;
});
