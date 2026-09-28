import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLATFORM_RULES } from '../platforms/rules';
import { PLATFORMS } from '../services/catalog';
import { CONNECTIONS, renderComplianceMatrix } from './matrix';

// 15.E4 / spec 18.1 — the checked-in compliance matrix must match the code. When this fails,
// run `npx tsx scripts/ops/compliance-matrix.ts` and commit ops/compliance-matrix.md.

describe('compliance matrix', () => {
  it('covers every destination and every connection it publishes through', () => {
    const md = renderComplianceMatrix();
    for (const p of PLATFORMS) {
      expect(md).toContain(`| ${p} |`);
      expect(CONNECTIONS[PLATFORM_RULES[p].connectionPlatform]).toBeDefined();
    }
  });

  it('ops/compliance-matrix.md is current', () => {
    const file = readFileSync(resolve(process.cwd(), 'ops/compliance-matrix.md'), 'utf8');
    expect(file.replace(/\r\n/g, '\n')).toBe(renderComplianceMatrix());
  });
});
