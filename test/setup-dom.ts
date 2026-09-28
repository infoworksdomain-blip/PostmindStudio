// Adds jest-dom matchers (toBeInTheDocument, …) when a test runs in jsdom; no-op in node tests.
import { afterEach, vi } from 'vitest';

// BACKLOG 16.1 — every component rendered through @testing-library/react gets the en-GB Studio
// i18n provider (test/i18n-wrapper.ts), so screens using useTranslations / useFormat render as
// they do in the app. A caller's own `wrapper` still applies, inside the provider.
vi.mock('@testing-library/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@testing-library/react')>();
  const { withIntlWrapper } = await import('./i18n-wrapper');
  type RenderOptions = import('@testing-library/react').RenderOptions;
  type HookOptions = import('@testing-library/react').RenderHookOptions<unknown>;
  const render = ((ui: Parameters<typeof actual.render>[0], options?: RenderOptions) =>
    actual.render(ui, {
      ...options,
      wrapper: withIntlWrapper(options?.wrapper),
    })) as typeof actual.render;
  const renderHook = ((callback: (props: unknown) => unknown, options?: HookOptions) =>
    actual.renderHook(callback, {
      ...options,
      wrapper: withIntlWrapper(options?.wrapper),
    })) as typeof actual.renderHook;
  return { ...actual, render, renderHook };
});

if (typeof window !== 'undefined') {
  // jsdom lacks the pointer-capture and scrolling APIs radix Select calls (language switcher).
  const proto = window.Element.prototype;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => cleanup());
}
