import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderComplianceMatrix } from '../../src/lib/studio/compliance/matrix';

// BACKLOG 15.E4 — regenerate ops/compliance-matrix.md (spec 18.1 compliance matrix):
//   npx tsx scripts/ops/compliance-matrix.ts
const target = resolve(process.cwd(), 'ops/compliance-matrix.md');
writeFileSync(target, renderComplianceMatrix(), 'utf8');
process.stdout.write(`wrote ${target}\n`);
