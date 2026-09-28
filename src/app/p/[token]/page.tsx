import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PublicPreview } from '@/components/studio/share/public-preview';

// BACKLOG 15.E5 — public smart-preview page (spec 4.4, decision P8). Outside the (studio) group:
// no app shell and no session. Never indexed; the token never leaves in a Referer header.
// BACKLOG 16.3 — the viewer’s locale (studio.locale cookie → Accept-Language → en-GB, resolved by
// src/i18n/request.ts), never the owner’s.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('share.preview');
  return {
    title: t('pageTitle'),
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

export default async function SharePreviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicPreview token={token} />;
}
