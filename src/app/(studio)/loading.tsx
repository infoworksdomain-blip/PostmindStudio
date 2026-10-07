import { PageSkeleton } from '@/components/studio/page-skeleton';

// BACKLOG 25.4 — while a (studio) page loads, the app shell (sidebar, top bar) stays and the
// content area shows the shape of a page; no full-page spinner.
export default function StudioLoading() {
  return <PageSkeleton />;
}
