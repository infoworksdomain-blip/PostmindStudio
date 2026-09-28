import type { Metadata } from 'next';
import { ApprovalWorkflowsScreen } from '@/components/studio/approvals/approval-workflows-screen';

export const metadata: Metadata = { title: 'Approval workflows' };

// 15.D3 — the organisation's multi-step approval workflows (spec 7.13).
export default function ApprovalWorkflowsPage() {
  return <ApprovalWorkflowsScreen />;
}
