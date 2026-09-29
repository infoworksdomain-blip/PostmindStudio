import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// next-intl's nested @swc/core declares an optional peer @swc/helpers >=0.5.17. The local npm
// resolves it from the hoisted 0.5.15 and drops the nested entry whenever the lockfile is
// regenerated (npm install --force), but CI's `npm ci` then refuses the lockfile ("Missing:
// @swc/helpers@0.5.23 from lock file"). This has broken CI three times; keep the entry.
describe('package-lock.json', () => {
  it('keeps the nested @swc/helpers entry that CI npm ci requires', () => {
    const lock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };
    if (!lock.packages['node_modules/next-intl/node_modules/@swc/core']) return;
    expect(lock.packages['node_modules/next-intl/node_modules/@swc/helpers']?.version).toBe(
      '0.5.23',
    );
  });
});
