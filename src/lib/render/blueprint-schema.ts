import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020';
import { ConfigurationError } from '../errors';

// Phase 17.7 — validate render.yaml against Render's published Blueprint JSON Schema.
// Render: "The Render Blueprint specification is served from SchemaStore.org ... also hosted in
// JSON Schema format at https://render.com/schema/render.yaml.json"
// (https://render.com/docs/blueprint-spec, "IDE validation", read 2026-09-28). The SchemaStore
// catalogue entry "Render Blueprints" (https://www.schemastore.org/api/json/catalog.json, fileMatch
// **/*render.yaml) points at that same URL.
//
// The schema is vendored byte-for-byte at ops/render/render.yaml.schema.json (downloaded
// 2026-09-28, upstream Last-Modified Sat, 26 Sep 2026 02:28:12 GMT) and pinned by its sha256 below,
// so CI is deterministic and never depends on render.com being reachable. To refresh it:
//   npx tsx scripts/render/validate-blueprint.ts --check-upstream   (reports drift, writes nothing)
// then replace the file and RENDER_SCHEMA_SHA256 in the same commit.
//
// The schema is draft 2020-12 (it uses unevaluatedProperties), hence Ajv2020. Formats ("uri" on
// maintenanceMode.uri) are not validated: Ajv needs the ajv-formats plugin for them, and no value
// in render.yaml uses a format.

export const RENDER_SCHEMA_URL = 'https://render.com/schema/render.yaml.json';
export const RENDER_SCHEMA_PATH = 'ops/render/render.yaml.schema.json';
export const RENDER_SCHEMA_SHA256 =
  '57aa0a1ff9c3b2d0fcb91b790b7b285aef6397adb0c92930e6e601054444cfe5';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Throws when the vendored schema is not the pinned file (edited, reformatted or replaced). */
export function assertPinnedSchema(raw: string, expected = RENDER_SCHEMA_SHA256): void {
  // CRLF → LF first: a Windows checkout with core.autocrlf must not fail the pin.
  const actual = sha256Hex(raw.replace(/\r\n/g, '\n'));
  if (actual !== expected) {
    throw new ConfigurationError(
      `${RENDER_SCHEMA_PATH} does not match the pinned sha256 (update RENDER_SCHEMA_SHA256 with the file)`,
      { expected, actual },
    );
  }
}

export interface SchemaProblem {
  path: string;
  message: string;
}

/** Validates a parsed Blueprint; an empty list means valid. */
export function validateBlueprint(doc: unknown, schema: object): SchemaProblem[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  const validate = ajv.compile(schema);
  if (validate(doc)) return [];
  return (validate.errors ?? []).map((e) => ({
    path: e.instancePath || '/',
    message: [e.message ?? 'invalid', e.params ? JSON.stringify(e.params) : '']
      .filter(Boolean)
      .join(' '),
  }));
}
