// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hardNavigate, isFramed } from '../../demo/shims/hard-navigate';

// The demo's stand-in for window.location.assign (demo/shims/hard-navigate.ts): it never leaves
// the page, so it always answers false (buttons stop spinning), and a download inside a frame
// (Claude's artifact viewer blocks downloads) shows a notice instead of silently doing nothing.

const mocks = vi.hoisted(() => ({
  toast: { info: vi.fn(), success: vi.fn() },
  navigate: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('swr', () => ({ mutate: vi.fn() }));
vi.mock('../../demo/router', () => ({ navigate: mocks.navigate }));

let click: ReturnType<typeof vi.spyOn>;

function frame(framed: boolean): void {
  Object.defineProperty(window, 'top', {
    configurable: true,
    get: () => (framed ? ({} as Window) : window),
  });
}

beforeEach(() => {
  mocks.toast.info.mockReset();
  mocks.toast.success.mockReset();
  mocks.navigate.mockReset();
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  frame(false);
});

afterEach(() => {
  click.mockRestore();
  frame(false);
});

describe('demo hardNavigate', () => {
  it('shows where the live app would go for Google and answers false', () => {
    expect(hardNavigate('https://accounts.google.com/o/oauth2/v2/auth?state=s')).toBe(false);
    expect(mocks.toast.info).toHaveBeenCalledWith(
      'In the live app this opens Google sign-in. The demo stays on this page.',
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('routes same-origin paths inside the page and answers false', () => {
    expect(hardNavigate('/projects?tab=all')).toBe(false);
    expect(mocks.navigate).toHaveBeenCalledWith('/projects?tab=all');
    expect(hardNavigate('#/settings')).toBe(false);
    expect(mocks.navigate).toHaveBeenCalledWith('#/settings');
  });

  it('saves the sample export when the demo has its own tab', () => {
    expect(hardNavigate('data:text/plain,hello')).toBe(false);
    expect(click).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).toHaveBeenCalled();
    expect(mocks.toast.info).not.toHaveBeenCalled();
  });

  it('says downloads are disabled inside a preview frame instead of doing nothing', () => {
    frame(true);
    expect(hardNavigate('data:text/plain,hello')).toBe(false);
    expect(click).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.info).toHaveBeenCalledWith(
      expect.stringContaining('Downloads are disabled in this preview'),
    );
  });
});

describe('isFramed', () => {
  it('is false for a top-level page, true in a frame or when the parent is cross-origin', () => {
    const self = {} as Window;
    expect(isFramed({ self, top: self } as unknown as Window)).toBe(false);
    expect(isFramed({ self, top: {} } as unknown as Window)).toBe(true);
    const crossOrigin = {
      self,
      get top(): Window {
        throw new DOMException('Blocked a frame', 'SecurityError');
      },
    };
    expect(isFramed(crossOrigin as unknown as Window)).toBe(true);
  });
});
