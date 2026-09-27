import type { Metadata } from 'next';
import { LibraryBrowse } from '@/components/studio/library/library-browse';

export const metadata: Metadata = { title: 'Reference library' };

export default function LibraryPage() {
  return <LibraryBrowse />;
}
