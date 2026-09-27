'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, Clapperboard, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import type { BrandKit, Project } from '@/lib/client/types';
import type { ProjectTemplate } from '../automation/automation';
import type { CreateProjectBody } from '../create/body';
import { EmptyState, ErrorState } from '../primitives';

// Step 3 — the first video from the built-in "Introduce yourself and what you do" template
// (spec 14.5). The request body matches what the Create screen sends for a TEMPLATE project
// (create/body.ts buildCreateBody), then generation starts as it does there.

const INTRO_PREFIX = 'introduce yourself';
const BRIEF_MAX = 4_000;

export function findIntroTemplate(templates: ProjectTemplate[]): ProjectTemplate | undefined {
  return templates.find((t) => t.builtIn && t.name.toLowerCase().startsWith(INTRO_PREFIX));
}

export function FirstVideoStep({
  businessId,
  projectId,
  onCreated,
}: {
  businessId: string;
  projectId: string | null;
  onCreated: (projectId: string) => Promise<void>;
}) {
  const briefId = useId();
  const templates = useApi<{ data: ProjectTemplate[] }>(projectId ? null : '/templates');
  const kits = useApi<{ data: BrandKit[] }>(projectId ? null : '/brand-kits', { businessId });
  const [brief, setBrief] = useState('');
  const [creating, setCreating] = useState(false);
  // A project created whose id could not be saved yet: a retry only re-saves it.
  const [unsaved, setUnsaved] = useState<string | null>(null);
  const template = templates.data ? findIntroTemplate(templates.data.data) : undefined;

  if (projectId) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="font-display text-3xl">Your first video is on its way</h2>
        <p className="text-sm text-muted-foreground">
          Studio is writing the script and gathering shots. Review it when it is ready, then
          publish.
        </p>
        <div>
          <Button asChild variant="outline">
            <Link href={`/projects/${projectId}`}>
              Open your video <ArrowRight />
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  async function startProject(templateId: string, name: string): Promise<string> {
    const rawInput = brief.trim();
    const kitId = kits.data?.data.find((k) => k.isDefault)?.id;
    const body: CreateProjectBody = {
      name,
      businessId,
      sourceType: 'TEMPLATE',
      templateId,
      ...(rawInput && { brief: { rawInput } }),
      ...(kitId && { brandKitId: kitId }),
    };
    const { project } = await api<{ project: Project }>('/projects', {
      method: 'POST',
      body,
      idempotencyKey: newIdempotencyKey(),
    });
    try {
      await api(`/projects/${project.id}/generate`, {
        method: 'POST',
        body: {},
        idempotencyKey: newIdempotencyKey(),
      });
    } catch (err) {
      toast.error(`Saved as a draft, but generation didn’t start: ${errorMessage(err)}`);
    }
    return project.id;
  }

  async function create() {
    if (!template) return;
    setCreating(true);
    try {
      const id = unsaved ?? (await startProject(template.id, template.name));
      setUnsaved(id);
      await onCreated(id);
      setUnsaved(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="font-display text-3xl">Make your first video</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Start with a short introduction: who you are and what you do. Studio plans the shots,
          writes the script and uses your brand kit.
        </p>
      </div>
      {templates.error && (
        <ErrorState error={templates.error} onRetry={() => void templates.mutate()} />
      )}
      {!templates.data && !templates.error && (
        <Skeleton className="h-24 rounded-xl" aria-label="Loading templates" />
      )}
      {templates.data && !template && (
        <EmptyState
          icon={<Clapperboard className="size-8" strokeWidth={1.5} />}
          title="The intro template isn’t available"
          description="You can still describe your first video on the Create screen."
          action={
            <Button asChild variant="outline">
              <Link href="/new">Open Create</Link>
            </Button>
          }
        />
      )}
      {template && (
        <>
          <div className="flex flex-col gap-2">
            <label htmlFor={briefId} className="text-sm font-medium">
              Anything to mention? (optional)
            </label>
            <textarea
              id={briefId}
              value={brief}
              maxLength={BRIEF_MAX}
              rows={3}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="Family bakery in Leeds since 2009 — sourdough, pastries and Saturday classes."
              className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </div>
          <div>
            <Button onClick={() => void create()} disabled={creating}>
              {creating ? <Loader2 className="animate-spin" /> : <Clapperboard />}
              Make my intro video
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
