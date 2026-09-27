import type { Metadata } from 'next';
import { BusinessScreen } from '@/components/studio/business/business-screen';

export const metadata: Metadata = { title: 'Business & images' };

export default function BusinessPage() {
  return <BusinessScreen />;
}
