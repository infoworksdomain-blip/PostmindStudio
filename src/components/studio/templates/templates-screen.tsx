'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import Link from 'next/link';
import { ArrowRight, Eye, Loader2, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { ConfirmDialog } from '../admin/confirm-dialog';
import { EmptyState, ErrorState, PageHeader, Section } from '../primitives';
import { useTemplateCategory } from './category';
import {
  TemplatePreviewDialog,
  templateHref,
  type TemplateKind,
  type TemplateRow,
} from './template-preview';

// BACKLOG 15.E7 — studio.postmind.ai/templates (Addendum A5.4 "save custom slideshows as their own
// templates for reuse"): the organisation's saved project and slideshow templates, with delete.
// Built-in templates are listed separately and are read-only.
// Data: GET /api/studio/templates, GET /api/studio/slideshow-templates,
//       DELETE /api/studio/templates/:id, DELETE /api/studio/slideshow-templates/:id.

const PATH: Record<TemplateKind, string> = {
  project: '/templates',
  slideshow: '/slideshow-templates',
};

function RowActions({
  kind,
  row,
  onPreview,
}: {
  kind: TemplateKind;
  row: TemplateRow;
  onPreview: () => void;
}) {
  const t = useTranslations('templates.list');
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label={t('previewAria', { name: row.name })}
        onClick={onPreview}
      >
        <Eye /> {t('preview')}
      </Button>
      <Button asChild size="sm" variant="outline">
        <Link href={templateHref(kind, row.id)} aria-label={t('useAria', { name: row.name })}>
          {t('use')} <ArrowRight className="rtl:-scale-x-100" />
        </Link>
      </Button>
    </>
  );
}

function TemplateList({
  kind,
  rows,
  onDeleted,
}: {
  kind: TemplateKind;
  rows: TemplateRow[];
  onDeleted: () => void;
}) {
  const t = useTranslations('templates');
  const tc = useTranslations('common.actions');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<TemplateRow | null>(null);
  const [previewing, setPreviewing] = useState<TemplateRow | null>(null);
  const category = useTemplateCategory();
  const remove = async (row: TemplateRow): Promise<boolean> => {
    setDeleting(row.id);
    try {
      await api(`${PATH[kind]}/${encodeURIComponent(row.id)}`, {
        method: 'DELETE',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('list.deleted', { name: row.name }));
      onDeleted();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setDeleting(null);
    }
  };
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        {kind === 'slideshow' ? t('list.emptySlideshow') : t('list.emptyProject')}
      </p>
    );
  return (
    <>
      <ul
        aria-label={kind === 'slideshow' ? t('list.slideshowAria') : t('list.projectAria')}
        className="grid gap-2"
      >
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"
          >
            <span className="min-w-0">
              <bdi className="font-medium">{row.name}</bdi>
              <span className="block text-xs text-muted-foreground">
                {t('list.meta', { category: category(row.category), date: f.date(row.createdAt) })}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              <RowActions kind={kind} row={row} onPreview={() => setPreviewing(row)} />
              <Button
                size="sm"
                variant="outline"
                aria-label={t('list.deleteAria', { name: row.name })}
                disabled={deleting === row.id}
                onClick={() => setConfirming(row)}
              >
                {deleting === row.id ? <Loader2 className="animate-spin" /> : <Trash2 />}{' '}
                {tc('delete')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {previewing && (
        <TemplatePreviewDialog row={previewing} kind={kind} onClose={() => setPreviewing(null)} />
      )}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t('list.confirmTitle', { name: confirming?.name ?? '' })}
        description={t('list.confirmBody')}
        confirmLabel={t('list.confirmDelete')}
        onConfirm={() => (confirming ? remove(confirming) : Promise.resolve(false))}
      />
    </>
  );
}

function BuiltInList({ rows }: { rows: Array<{ kind: TemplateKind; row: TemplateRow }> }) {
  const t = useTranslations('templates');
  const [previewing, setPreviewing] = useState<{ kind: TemplateKind; row: TemplateRow } | null>(
    null,
  );
  return (
    <>
      <ul aria-label={t('builtInAria')} className="grid gap-2 sm:grid-cols-2">
        {rows.map(({ kind, row }) => (
          <li
            key={`${kind}-${row.id}`}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm"
          >
            <bdi className="min-w-0 font-medium">{row.name}</bdi>
            <span className="flex flex-wrap items-center gap-1.5">
              <RowActions kind={kind} row={row} onPreview={() => setPreviewing({ kind, row })} />
            </span>
          </li>
        ))}
      </ul>
      {previewing && (
        <TemplatePreviewDialog
          row={previewing.row}
          kind={previewing.kind}
          onClose={() => setPreviewing(null)}
        />
      )}
    </>
  );
}

export function TemplatesScreen() {
  const t = useTranslations('templates');
  const project = useApi<{ data: TemplateRow[] }>(PATH.project);
  const slideshow = useApi<{ data: TemplateRow[] }>(PATH.slideshow);
  const error = project.error ?? slideshow.error;
  const loading = project.isLoading || slideshow.isLoading;
  const own = (rows: TemplateRow[] | undefined) => (rows ?? []).filter((r) => r.organisationId);
  const builtIns = [
    ...(project.data?.data ?? [])
      .filter((r) => !r.organisationId)
      .map((row) => ({ kind: 'project' as const, row })),
    ...(slideshow.data?.data ?? [])
      .filter((r) => !r.organisationId)
      .map((row) => ({ kind: 'slideshow' as const, row })),
  ];
  const retry = () => {
    void project.mutate();
    void slideshow.mutate();
  };

  return (
    <>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('description')} />
      {error && <ErrorState error={error} onRetry={retry} />}
      {loading && <Skeleton aria-label={t('loading')} className="h-48 rounded-xl" />}
      {!loading && !error && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Section title={t('slideshowTitle')}>
            <TemplateList
              kind="slideshow"
              rows={own(slideshow.data?.data)}
              onDeleted={() => void slideshow.mutate()}
            />
          </Section>
          <Section title={t('projectTitle')}>
            <TemplateList
              kind="project"
              rows={own(project.data?.data)}
              onDeleted={() => void project.mutate()}
            />
          </Section>
          <Section title={t('builtInTitle')} className="lg:col-span-2">
            {builtIns.length === 0 ? (
              <EmptyState illustration="templates" title={t('noBuiltIns')} />
            ) : (
              <BuiltInList rows={builtIns} />
            )}
          </Section>
        </div>
      )}
    </>
  );
}
