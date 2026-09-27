// Adds jest-dom matchers (toBeInTheDocument, …) when a test runs in jsdom; no-op in node tests.
import { afterEach } from 'vitest';

if (typeof window !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => cleanup());
}
