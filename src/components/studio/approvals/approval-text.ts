'use client';

import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { useFormat } from '@/lib/client/format';
import {
  isSuggestedRole,
  roleLabel,
  type ApprovalStatus,
  type WorkflowAppliesTo,
  type WorkflowStep,
} from './types';

// BACKLOG 16.x — the approval workflow sentences ("Step 1 of 2 — waiting for client reviewer",
// "Applies to business biz_1 · TikTok") built from the `approvals` catalogue. Suggested roles
// have translated, pluralised labels; any other role name is shown as typed.

export interface ApprovalText {
  /** "admin" (one approver) or "2 client reviewers". */
  describeStep: (step: WorkflowStep) => string;
  /** One line describing which projects a workflow applies to. */
  describeAppliesTo: (appliesTo: WorkflowAppliesTo) => string;
  /** "Step 1 of 2 — waiting for client reviewer (1 of 2 approvals)". */
  stepIndicatorText: (status: ApprovalStatus) => string;
}

export function useApprovalText(): ApprovalText {
  const t = useTranslations('approvals');
  const f = useFormat();
  return useMemo<ApprovalText>(() => {
    const role = (name: string, count: number) =>
      isSuggestedRole(name)
        ? t(`roles.${name}`, { count })
        : t('roles.custom', { count, role: roleLabel(name) });

    const describeAppliesTo = (appliesTo: WorkflowAppliesTo) => {
      const parts: string[] = [];
      if (appliesTo.businessIds.length)
        parts.push(
          t('appliesTo.businesses', {
            count: appliesTo.businessIds.length,
            ids: f.list(appliesTo.businessIds, 'unit'),
          }),
        );
      if (appliesTo.platforms.length)
        parts.push(f.list(appliesTo.platforms.map(f.platform), 'disjunction'));
      if (appliesTo.tags.length)
        parts.push(t('appliesTo.tagged', { tags: f.list(appliesTo.tags, 'unit') }));
      return parts.length
        ? t('appliesTo.some', { targets: parts.join(' · ') })
        : t('appliesTo.every');
    };

    const stepIndicatorText = (status: ApprovalStatus) => {
      if (!status.workflow) return '';
      const name = status.workflow.name;
      const step = f.number(status.stepIndex + 1);
      const total = f.number(status.stepCount);
      if (status.outcome === 'approved') return t('indicator.approved', { name });
      if (status.outcome === 'rejected') return t('indicator.rejected', { name, step, total });
      const waiting = status.waitingFor;
      if (!waiting) return t('indicator.step', { name, step, total });
      const waitingRole = role(waiting.role, 1);
      return waiting.minApprovers > 1
        ? t('indicator.waitingCount', {
            step,
            total,
            role: waitingRole,
            approvals: f.number(waiting.approvals),
            required: f.number(waiting.minApprovers),
          })
        : t('indicator.waiting', { step, total, role: waitingRole });
    };

    return {
      describeStep: (step) => role(step.role, step.minApprovers),
      describeAppliesTo,
      stepIndicatorText,
    };
  }, [t, f]);
}
