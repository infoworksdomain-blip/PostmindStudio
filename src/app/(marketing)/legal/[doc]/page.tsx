import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { legalDocKey } from '@/components/marketing/legal-doc-keys';
import { LegalDocumentView } from '@/components/marketing/legal-document-view';
import { isLegalDoc, readLegalDocument } from '@/lib/legal/documents';
import { publicPageMetadata } from '@/lib/seo/page-metadata';

// Phase 18 §3 /legal/{terms,privacy,cookies,acceptable-use,dpa,subprocessors} — the operator's
// Markdown from content/legal/<locale>/<doc>.md (en-GB fallback). Read per request so replacing a
// file on the server needs no rebuild.

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ doc: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const key = legalDocKey((await params).doc);
  if (!key) return {};
  const [t, seo, meta] = await Promise.all([
    getTranslations('legal.docs'),
    getTranslations('seo.legal'),
    getTranslations('marketing.meta'),
  ]);
  return publicPageMetadata({
    path: `/legal/${(await params).doc}`,
    title: t(key),
    description: seo(key),
    locale: await getLocale(),
    imageAlt: meta('ogAlt'),
  });
}

export default async function LegalPage({ params }: Props) {
  const { doc } = await params;
  const key = legalDocKey(doc);
  if (!key || !isLegalDoc(doc)) notFound();
  const document = await readLegalDocument(doc, await getLocale());
  if (!document) notFound();
  return (
    <LegalDocumentView
      docKey={key}
      markdown={document.markdown}
      placeholder={document.placeholder}
      draft={document.state === 'fill_in'}
      fallback={document.fallback}
    />
  );
}
