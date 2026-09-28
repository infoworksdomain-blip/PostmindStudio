'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { ChevronRight, ListChecks, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, useApi } from '@/lib/client/api';
import { useBusiness } from '../business-context';
import { EmptyState, ErrorState, PageHeader, Section } from '../primitives';
import {
  describeAppliesTo,
  describeStep,
  type ApprovalWorkflow,
  type WorkflowInput,
} from './types';
import { WorkflowForm } from './workflow-form';

// 15.D3 — Approval workflows (spec 7.13; spec 3.3 "agency … approval workflows"): list, create,
// edit and delete the organisation's multi-step approval workflows. Organisation owners and
// admins can change them (the API answers 403 for anyone else); everyone can read them.

type Editing = { mode: 'new' } | { mode: 'edit'; workflow: ApprovalWorkflow } | null;

function StepChain({ workflow }: { workflow: ApprovalWorkflow }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label={`${workflow.name} steps`}>
      {workflow.steps.map((step, index) => (
        <li key={`${index}-${step.role}`} className="flex items-center gap-1.5">
          {index > 0 && (
            <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden strokeWidth={2} />
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs">
            <span
              aria-hidden
              className="inline-flex size-4 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground tabular"
            >
              {index + 1}
            </span>
            <span className="sr-only">Step {index + 1}:</span>
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
  onEdit,
  onDelete,
}: {
  workflow: ApprovalWorkflow;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-shadow hover:shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">{workflow.name}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {describeAppliesTo(workflow.appliesTo)}
          </p>
        </div>
        <div className="flex gap-1.5">
          <Button variant="outline" size="sm" onClick={onEdit} disabled={busy}>
            <Pencil /> Edit
          </Button>
          {confirming ? (
            <>
              <Button variant="destructive" size="sm" onClick={onDelete} disabled={busy}>
                Confirm delete
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(true)}
              disabled={busy}
              aria-label={`Delete ${workflow.name}`}
            >
              <Trash2 /> Delete
            </Button>
          )}
        </div>
      </div>
      <StepChain workflow={workflow} />
    </li>
  );
}

export function ApprovalWorkflowsScreen() {
  const { businessId } = useBusiness();
  const res = useApi<{ data: ApprovalWorkflow[] }>('/approval-workflows');
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);

  const save = async (input: WorkflowInput) => {
    setBusy(true);
    try {
      if (editing?.mode === 'edit') {
        await api(`/approval-workflows/${editing.workflow.id}`, { method: 'PATCH', body: input });
        toast.success('Workflow saved. Reviews already under way keep their steps.');
      } else {
        await api('/approval-workflows', { method: 'POST', body: input });
        toast.success('Workflow created.');
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
      toast.success(`Deleted “${workflow.name}”.`);
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
        eyebrow="Setup"
        title="Approval workflows"
        description="Ordered sign-off steps for client or legal review. A video waits in review until every step is approved, and only then publishes. Projects no workflow applies to need one approval."
        actions={
          editing ? null : (
            <Button onClick={() => setEditing({ mode: 'new' })}>
              <Plus /> New workflow
            </Button>
          )
        }
      />
      <div className="flex flex-col gap-6">
        {editing && (
          <Section
            title={editing.mode === 'edit' ? `Edit “${editing.workflow.name}”` : 'New workflow'}
          >
            <WorkflowForm
              key={editing.mode === 'edit' ? editing.workflow.id : 'new'}
              initial={editing.mode === 'edit' ? editing.workflow : undefined}
              currentBusinessId={businessId}
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
              icon={<ListChecks className="size-8" strokeWidth={1.5} />}
              title="No approval workflows yet"
              description="Every video needs one approval. Add a workflow when a client, a manager or legal must sign off first."
              action={
                <Button onClick={() => setEditing({ mode: 'new' })}>
                  <Plus /> New workflow
                </Button>
              }
            />
          )
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Approval workflows">
            {workflows.map((w) => (
              <WorkflowCard
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
