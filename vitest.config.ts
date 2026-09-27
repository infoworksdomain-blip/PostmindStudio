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
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
