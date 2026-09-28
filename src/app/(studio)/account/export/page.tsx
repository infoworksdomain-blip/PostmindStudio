import type { Metadata } from 'next';
import { ExportScreen } from '@/components/studio/account/export-screen';

export const metadata: Metadata = { title: 'Export your data' };

export default function AccountExportPage() {
  return <ExportScreen />;
}
