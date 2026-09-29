import { toast } from 'sonner';
import { mutate } from 'swr';
import { navigate } from '../router';

// Demo stand-in for src/lib/client/navigate.ts (aliased by scripts/demo/build.mjs). The app does
// full-page navigations after sign-in / sign-out, an organisation switch, an invite, an OAuth
// start, Stripe and downloads; in the single-file, hash-routed demo those would leave the page and
// leave it blank. Here:
//   same-origin paths and "#/…" links  → the demo's hash route (query kept; "/" → "#/", which
//                                         shows the landing page when signed out, else the tour)
//   data: / blob: URLs (the export)     → saved as a file, the page stays
//   anything else (Google, Stripe, …)   → a notice saying where the live app would go

const EXTERNAL_LABELS: Array<[RegExp, string]> = [
  [/(^|\.)accounts\.google\.com$/, 'Google sign-in'],
  [/(^|\.)stripe\.com$/, 'Stripe'],
  [/(^|\.)(facebook|meta)\.com$/, 'Facebook Login for Business'],
  [/(^|\.)tiktok\.com$/, 'TikTok’s authorisation page'],
  [/(^|\.)google\.com$/, 'Google'],
];

function download(url: string): void {
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

export function hardNavigate(url: string): void {
  if (url.startsWith('#')) {
    navigate(url);
    return;
  }
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    download(url);
    return;
  }
  let target: URL;
  try {
    target = new URL(url, 'https://studio.demo');
  } catch {
    toast.info('In the live app this opens another page.');
    return;
  }
  const sameOrigin =
    url.startsWith('/') ||
    target.origin === 'https://studio.demo' ||
    target.origin === window.location.origin;
  if (sameOrigin && !url.startsWith('//')) {
    // "/" is the landing page for a signed-out visitor and the tour otherwise (demo/app.tsx).
    navigate(`${target.pathname}${target.search}`);
    return;
  }
  const label = EXTERNAL_LABELS.find(([re]) => re.test(target.hostname))?.[1] ?? target.hostname;
  toast.info(`In the live app this opens ${label}. The demo stays on this page.`);
}
