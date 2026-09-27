import type { Metadata } from 'next';
import { AnalyticsDashboard } from '@/components/studio/analytics/analytics-dashboard';

export const metadata: Metadata = { title: 'Analytics' };

export default function AnalyticsPage() {
  return <AnalyticsDashboard />;
}
