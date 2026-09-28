import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// BACKLOG 15.D10 — A14.2 launch-readiness evals (test/eval/*.eval.ts): live classifier accuracy
// over the H-03 labelled set and scan timing against staging. Operator-run with staging keys
// (`npm run test:eval`, runbooks/slo-and-launch-readiness.md); never part of `npm test`.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['test/eval/**/*.eval.ts'],
    // 50 live crawls + classifications, or 20 end-to-end scans (≤ 5 min each, 3 at a time).
    testTimeout: 60 * 60_000,
  },
});
