import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Component tests (.test.tsx) use the React automatic JSX runtime; tsconfig keeps
  // jsx: preserve for Next.js.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts'],
    // Component tests opt into jsdom with a `// @vitest-environment jsdom` pragma.
    setupFiles: ['test/setup-dom.ts'],
    // jsdom component tests drive whole screens with user-event; with ~190 files running in
    // parallel on a loaded machine they exceed vitest's 5 s default without being wrong.
    testTimeout: 20_000,
    // DB suites seed taxonomy/presets in beforeAll; on the single-connection local database under
    // load that exceeds the 10 s default without anything being wrong.
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
