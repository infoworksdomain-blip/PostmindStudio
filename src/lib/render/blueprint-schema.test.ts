import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../errors';
import {
  assertPinnedSchema,
  RENDER_SCHEMA_PATH,
  sha256Hex,
  validateBlueprint,
} from './blueprint-schema';

// Phase 17.7 — render.yaml against Render's published Blueprint JSON Schema (vendored, pinned).

const ROOT = join(__dirname, '..', '..', '..');
const rawSchema = readFileSync(join(ROOT, RENDER_SCHEMA_PATH), 'utf8');
const schema = JSON.parse(rawSchema) as object;
const blueprint = load(readFileSync(join(ROOT, 'render.yaml'), 'utf8')) as {
  projects: Array<{ environments: Array<{ services: Array<Record<string, unknown>> }> }>;
};

describe('Render Blueprint schema', () => {
  it('the vendored schema is the pinned upstream file', () => {
    expect(() => assertPinnedSchema(rawSchema)).not.toThrow();
  });

  it('refuses a vendored schema that was edited or reformatted', () => {
    expect(() => assertPinnedSchema(`${rawSchema}\n`)).toThrow(ConfigurationError);
    expect(sha256Hex('a')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('render.yaml is valid', () => {
    expect(validateBlueprint(blueprint, schema)).toEqual([]);
  });

  it('reports an unknown service field', () => {
    const doc = structuredClone(blueprint);
    doc.projects[0]!.environments[0]!.services[0]!.notAField = true;
    expect(validateBlueprint(doc, schema).length).toBeGreaterThan(0);
  });

  it('reports a bad enum value (cron plan) with its path', () => {
    const doc = {
      services: [
        {
          type: 'cron',
          name: 'x',
          runtime: 'docker',
          schedule: '0 3 * * *',
          plan: 'huge',
        },
      ],
    };
    const problems = validateBlueprint(doc, schema);
    expect(problems.some((p) => p.path.startsWith('/services/0'))).toBe(true);
  });

  it('accepts a minimal docker cron job', () => {
    const doc = {
      services: [
        {
          type: 'cron',
          name: 'x',
          runtime: 'docker',
          schedule: '0 3 * * *',
          dockerCommand: 'npx tsx scripts/ops/backup-storage.ts --apply',
        },
      ],
    };
    expect(validateBlueprint(doc, schema)).toEqual([]);
  });
});
