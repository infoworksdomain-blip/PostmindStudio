'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { LayoutTemplate, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import { formatDate } from '@/lib/client/format';
import { EmptyState, ErrorState, PageHeader, Section } from '../primitives';

// BACKLOG 15.E7 — studio.postmind.ai/templates (Addendum A5.4 "save custom slideshows as their own
// templates for reuse"): the organisation's saved project and slideshow templates, with delete.
// Built-in templates are listed separately and are read-only.
// Data: GET /api/studio/templates, GET /api/studio/slideshow-templates,
//       DELETE /api/studio/templates/:id, DELETE /api/studio/slideshow-templates/:id.

export interface TemplateRow {
  id: string;
  name: string;
  category: string;
  organisationId: string | null;
  createdAt: string;
}

type Kind = 'project' | 'slideshow';

const PATH: Record<Kind, string> = { project: '/templates', slideshow: '/slideshow-templates' };

function TemplateList({
  kind,
  rows,
  onDeleted,
}: {
  kind: Kind;
  rows: TemplateRow[];
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const remove = async (row: TemplateRow) => {
    setDeleting(row.id);
    try {
      await api(`${PATH[kind]}/${encodeURIComponent(row.id)}`, {
        method: 'DELETE',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(`Deleted “${row.name}”`);
      onDeleted();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeleting(null);
    }
  };
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        {kind === 'slideshow'
          ? 'Save a slideshow as a template from its review screen to reuse it here.'
          : 'Save a project as a template from its review screen to reuse it here.'}
      </p>
    );
  return (
    <ul aria-label={`${kind} templates`} className="grid gap-2">
      {rows.map((row) => (
        <li
          key={row.id}
          className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"
        >
          <span className="min-w-0">
            <bdi className="font-medium">{row.name}</bdi>
            <span className="block text-xs text-muted-foreground">
              {row.category.replace(/_/g, ' ')} · saved {formatDate(row.createdAt)}
            </span>
          </span>
          <Button
            size="sm"
            variant="outline"
            aria-label={`Delete ${row.name}`}
            disabled={deleting === row.id}
            onClick={() => void remove(row)}
          >
            {deleting === row.id ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function TemplatesScreen() {
  const project = useApi<{ data: TemplateRow[] }>(PATH.project);
  const slideshow = useApi<{ data: TemplateRow[] }>(PATH.slideshow);
  const error = project.error ?? slideshow.error;
  const loading = project.isLoading || slideshow.isLoading;
  const own = (rows: TemplateRow[] | undefined) => (rows ?? []).filter((r) => r.organisationId);
  const builtIns = [
    ...(project.data?.data ?? []).filter((r) => !r.organisationId),
    ...(slideshow.data?.data ?? []).filter((r) => !r.organisationId),
  ];
  const retry = () => {
    void project.mutate();
    void slideshow.mutate();
  };

  return (
    <>
      <PageHeader
        eyebrow="Make"
        title="Templates"
        description="Your saved project and slideshow templates. Deleting a template never changes videos already made from it."
      />
      {error && <ErrorState error={error} onRetry={retry} />}
      {loading && <Skeleton aria-label="Loading templates" className="h-48 rounded-xl" />}
      {!loading && !error && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Slideshow templates">
            <TemplateList
              kind="slideshow"
              rows={own(slideshow.data?.data)}
              onDeleted={() => void slideshow.mutate()}
            />
          </Section>
          <Section title="Project templates">
            <TemplateList
              kind="project"
              rows={own(project.data?.data)}
              onDeleted={() => void project.mutate()}
            />
          </Section>
          <Section title="Built-in templates" className="lg:col-span-2">
            {builtIns.length === 0 ? (
              <EmptyState
                icon={<LayoutTemplate className="size-8" strokeWidth={1.5} />}
                title="No built-in templates"
              />
            ) : (
              <ul className="flex flex-wrap gap-2 text-sm">
                {builtIns.map((b) => (
                  <li key={b.id} className="rounded-full bg-secondary px-3 py-1">
                    {b.name}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </>
  );
}
