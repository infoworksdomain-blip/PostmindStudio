import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MetaDeletionStatus } from '@/components/studio/connections/meta-deletion-status';
import { readDeletionCode } from '@/lib/studio/services/meta-connect';

// Phase 18 §2.10 — the URL POST /api/meta/data-deletion returns to Meta. Public (no session):
// the signed confirmation code is verified with the app secret, so a made-up code shows "not
// found" rather than a fake status. Never indexed. In the viewer's locale (src/i18n/request.ts).
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('connections.dataDeletion');
  return { title: t('pageTitle'), robots: { index: false, follow: false } };
}

export default async function MetaDataDeletionPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const raw = (await searchParams).code;
  const code = (Array.isArray(raw) ? raw[0] : raw)?.slice(0, 64) ?? '';
  const secret = process.env.META_APP_SECRET?.trim();
  const status = code && secret ? readDeletionCode(secret, code) : null;
  return <MetaDeletionStatus code={code} status={status} />;
}
