import type { Metadata } from 'next';
import { TemplatesScreen } from '@/components/studio/templates/templates-screen';

export const metadata: Metadata = { title: 'Templates' };

export default function TemplatesPage() {
  return <TemplatesScreen />;
}
