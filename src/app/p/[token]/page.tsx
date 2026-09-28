import type { Metadata } from 'next';
import { PublicPreview } from '@/components/studio/share/public-preview';

// BACKLOG 15.E5 — public smart-preview page (spec 4.4, decision P8). Outside the (studio) group:
// no app shell and no session. Never indexed; the token never leaves in a Referer header.
export const metadata: Metadata = {
  title: 'Video preview',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function SharePreviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicPreview token={token} />;
}
