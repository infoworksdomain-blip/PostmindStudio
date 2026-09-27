import type { Metadata } from 'next';
import { AdminCentre } from '@/components/studio/admin/admin-centre';

export const metadata: Metadata = { title: 'Admin Centre' };

export default function AdminPage() {
  return <AdminCentre />;
}
