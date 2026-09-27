import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// BACKLOG 13.31 — the live platform canary only (test/canary/*.canary.ts). Run by
// .github/workflows/platform-canary.yml; kept out of the default suite because it calls real
// platform APIs with sandbox credentials.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['test/canary/**/*.canary.ts'],
    testTimeout: 60_000,
  },
});
