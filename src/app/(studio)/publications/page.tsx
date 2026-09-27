import type { Metadata } from 'next';
import { PublicationsList } from '@/components/studio/publications/publications-list';

export const metadata: Metadata = { title: 'Publications' };

export default function PublicationsPage() {
  return <PublicationsList />;
}
