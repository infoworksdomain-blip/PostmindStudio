'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { EmptyState, ErrorState, PageHeader, Section } from '../primitives';
import { useApprovalText } from './approval-text';
import type { ApprovalWorkflow, WorkflowInput } from './types';
import { WorkflowForm } from './workflow-form';

// 15.D3 — Approval workflows (spec 7.13; spec 3.3 "agency … approval workflows"): list, create,
// edit and delete the organisation's multi-step approval workflows. Organisation owners and
// admins can change them (the API answers 403 for anyone else); everyone can read them.

type Editing = { mode: 'new' } | { mode: 'edit'; workflow: ApprovalWorkflow } | null;

function StepChain({ workflow }: { workflow: ApprovalWorkflow }) {
  const t = useTranslations('approvals.card');
  const f = useFormat();
  const { describeStep } = useApprovalText();
  return (
    <ol
      className="flex flex-wrap items-center gap-1.5"
      aria-label={t('stepsAria', { name: workflow.name })}
    >
      {workflow.steps.map((step, index) => (
        <li key={`${index}-${step.role}`} className="flex items-center gap-1.5">
          {index > 0 && (
            <ChevronRight
              className="size-3.5 text-muted-foreground rtl:-scale-x-100"
              aria-hidden
              strokeWidth={2}
            />
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs">
            <span
              aria-hidden
              className="inline-flex size-4 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground tabular"
            >
              {f.number(index + 1)}
            </span>
            <span className="sr-only">{t('stepNumber', { number: f.number(index + 1) })}</span>
            {describeStep(step)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function WorkflowCard({
  workflow,
  busy,
  businessNames,
  onEdit,
  onDelete,
}: {
  workflow: ApprovalWorkflow;
  /** Business id → name, so the card says "Leeds Sourdough", not the raw id. */
  businessNames: Readonly<Record<string, string>> | undefined;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('approvals.card');
  const tc = useTranslations('common.actions');
  const { describeAppliesTo, removedBusinessNote } = useApprovalText();
  const removedNote = removedBusinessNote(workflow.appliesTo, businessNames);
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-shadow hover:shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">{workflow.name}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {describeAppliesTo(workflow.appliesTo, businessNames)}
          </p>
          {removedNote && (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {removedNote}
            </p>
          )}
        </div>
        <div className="flex gap-1.5">
          <Button variant="outline" size="sm" onClick={onEdit} disabled={busy}>
            <Pencil /> {tc('edit')}
          </Button>
          {confirming ? (
            <>
              <Button variant="destructive" size="sm" onClick={onDelete} disabled={busy}>
                {t('confirmDelete')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                {t('keep')}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(true)}
              disabled={busy}
              aria-label={t('deleteAria', { name: workflow.name })}
            >
              <Trash2 /> {tc('delete')}
            </Button>
          )}
        </div>
      </div>
      <StepChain workflow={workflow} />
    </li>
  );
}

export function ApprovalWorkflowsScreen() {
  const t = useTranslations('approvals.screen');
  const errorMessage = useErrorMessage();
  const res = useApi<{ data: ApprovalWorkflow[] }>('/approval-workflows');
  const businesses = useApi<{ data: Array<{ id: string; name: string }> }>('/businesses');
  // undefined until the list has loaded, so a card never calls a business "removed" while loading.
  const businessNames = businesses.data
    ? Object.fromEntries(businesses.data.data.map((b) => [b.id, b.name]))
    : undefined;
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);

  const save = async (input: WorkflowInput) => {
    setBusy(true);
    try {
      if (editing?.mode === 'edit') {
        await api(`/approval-workflows/${editing.workflow.id}`, { method: 'PATCH', body: input });
        toast.success(t('saved'));
      } else {
        await api('/approval-workflows', { method: 'POST', body: input });
        toast.success(t('created'));
      }
      setEditing(null);
      await res.mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (workflow: ApprovalWorkflow) => {
    setBusy(true);
    try {
      await api(`/approval-workflows/${workflow.id}`, { method: 'DELETE' });
      toast.success(t('deleted', { name: workflow.name }));
      await res.mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const workflows = res.data?.data ?? [];

  return (
    <>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        description={t('description')}
        actions={
          editing ? null : (
            <Button onClick={() => setEditing({ mode: 'new' })}>
              <Plus /> {t('newWorkflow')}
            </Button>
          )
        }
      />
      <div className="flex flex-col gap-6">
        {editing && (
          <Section
            title={
              editing.mode === 'edit'
                ? t('editTitle', { name: editing.workflow.name })
                : t('newWorkflow')
            }
          >
            <WorkflowForm
              key={editing.mode === 'edit' ? editing.workflow.id : 'new'}
              initial={editing.mode === 'edit' ? editing.workflow : undefined}
              businesses={businesses.data?.data ?? []}
              saving={busy}
              onSubmit={(input) => void save(input)}
              onCancel={() => setEditing(null)}
            />
          </Section>
        )}
        {res.error ? (
          <ErrorState error={res.error} onRetry={() => void res.mutate()} />
        ) : !res.data ? (
          <div className="flex flex-col gap-3" aria-busy>
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ) : workflows.length === 0 ? (
          !editing && (
            <EmptyState
              media="approvals"
              title={t('emptyTitle')}
              description={t('emptyBody')}
              action={
                <Button onClick={() => setEditing({ mode: 'new' })}>
                  <Plus /> {t('newWorkflow')}
                </Button>
              }
            />
          )
        ) : (
          <ul className="flex flex-col gap-3" aria-label={t('listAria')}>
            {workflows.map((w) => (
              <WorkflowCard
                businessNames={businessNames}
                key={w.id}
                workflow={w}
                busy={busy}
                onEdit={() => setEditing({ mode: 'edit', workflow: w })}
                onDelete={() => void remove(w)}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
