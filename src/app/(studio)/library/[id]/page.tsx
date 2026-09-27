import type { Metadata } from 'next';
import { LibraryDetail } from '@/components/studio/library/library-detail';

export const metadata: Metadata = { title: 'Reference video' };

export default async function LibraryVideoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LibraryDetail id={id} />;
}
