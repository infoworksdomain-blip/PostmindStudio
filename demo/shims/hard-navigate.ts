import { toast } from 'sonner';
import { mutate } from 'swr';
import { navigate } from '../router';

// Demo stand-in for src/lib/client/navigate.ts (aliased by scripts/demo/build.mjs). The app does
// full-page navigations after sign-in / sign-out, an organisation switch, an invite, an OAuth
// start, Stripe and downloads; in the single-file, hash-routed demo those would leave the page and
// leave it blank. Here:
//   same-origin paths and "#/…" links  → the demo's hash route (query kept; "/" → "#/", which
//                                         shows the landing page when signed out, else the tour)
//   data: / blob: URLs (the export)     → saved as a file, the page stays; inside a frame (Claude's
//                                         artifact viewer blocks downloads) a notice says so instead
//   anything else (Google, Stripe, …)   → a notice saying where the live app would go
// It never leaves the page, so it always answers false: buttons that spin "until the page
// unloads" (Continue with Google, Connect) stop spinning.

const EXTERNAL_LABELS: Array<[RegExp, string]> = [
  [/(^|\.)accounts\.google\.com$/, 'Google sign-in'],
  [/(^|\.)stripe\.com$/, 'Stripe'],
  [/(^|\.)(facebook|meta)\.com$/, 'Facebook Login for Business'],
  [/(^|\.)tiktok\.com$/, 'TikTok’s authorisation page'],
  [/(^|\.)google\.com$/, 'Google'],
];

/**
 * Inside a frame (Claude's artifact viewer, a sandboxed iframe) a download link does nothing, so
 * the demo says so rather than failing silently. A cross-origin parent throws on access: framed.
 */
export function isFramed(win: Window = window): boolean {
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}

function download(url: string): void {
  if (isFramed()) {
    toast.info(
      'Downloads are disabled in this preview. Open the demo in its own browser tab to save the sample export; the live app downloads a ZIP of the organisation’s data.',
    );
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = 'postmind-studio-demo-export.txt';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast.success(
    'Saved the sample export. The live app downloads a ZIP of the organisation’s data.',
  );
}

/** A reload would lose the demo's in-memory state (sign-in, sample data): re-fetch instead. */
export function hardReload(): void {
  void mutate(() => true);
}

/** Same contract as src/lib/client/navigate.ts; false: the demo never leaves the page. */
export function hardNavigate(url: string): boolean {
  if (url.startsWith('#')) {
    navigate(url);
    return false;
  }
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    download(url);
    return false;
  }
  let target: URL;
  try {
    target = new URL(url, 'https://studio.demo');
  } catch {
    toast.info('In the live app this opens another page.');
    return false;
  }
  const sameOrigin =
    url.startsWith('/') ||
    target.origin === 'https://studio.demo' ||
    target.origin === window.location.origin;
  if (sameOrigin && !url.startsWith('//')) {
    // "/" is the landing page for a signed-out visitor and the tour otherwise (demo/app.tsx).
    navigate(`${target.pathname}${target.search}`);
    return false;
  }
  const label = EXTERNAL_LABELS.find(([re]) => re.test(target.hostname))?.[1] ?? target.hostname;
  toast.info(`In the live app this opens ${label}. The demo stays on this page.`);
  return false;
}
