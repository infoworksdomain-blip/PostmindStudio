import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildInternalOpenApi } from '../../src/lib/studio/api/internal-contract';

// BACKLOG 14.10 — regenerate integrations/core/openapi.json from the internal routes' zod schemas
// (src/lib/studio/api/internal-contract.ts). Run after changing an internal endpoint:
//   npx tsx scripts/core/generate-openapi.ts
// test/integrations/openapi-drift.test.ts fails until the committed file matches.

const OPENAPI_PATH = resolve(__dirname, '../../integrations/core/openapi.json');

writeFileSync(OPENAPI_PATH, `${JSON.stringify(buildInternalOpenApi(), null, 2)}\n`, 'utf8');
process.stdout.write(`wrote ${OPENAPI_PATH}\n`);
