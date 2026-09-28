import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ApprovalWorkflowsScreen } from '@/components/studio/approvals/approval-workflows-screen';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shell.pageTitle');
  return { title: t('approvals') };
}

// 15.D3 — the organisation's multi-step approval workflows (spec 7.13).
export default function ApprovalWorkflowsPage() {
  return <ApprovalWorkflowsScreen />;
}
