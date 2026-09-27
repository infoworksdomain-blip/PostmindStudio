'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ArrowRight, Building2, Clapperboard, Layers, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import type { BrandKit, PlatformConnection, Project } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { useBusiness } from '../business-context';
import { EmptyState } from '../primitives';
import { TemplatePicker } from '../slideshow/template-picker';
import type { ProjectTemplate } from '../automation/automation';
import { AutoPublishOption } from './auto-publish-option';
import {
  BRIEF_MAX,
  buildCreateBody,
  publishPlatforms,
  usesTemplate,
  validateCreate,
  type CreateSource,
  type CreateState,
  type Reference,
} from './body';
import { AdvancedOptions, BrandKitSelect, LengthToggle, PlatformChips } from './create-options';
import { defaultPlatforms } from './formats';
import { ProjectTemplatePicker } from './project-template-picker';
import { ReferenceBanner } from './reference-banner';

// BACKLOG 10.3 — Create (spec 14.1): one text box, one button. Defaults are pre-filled from the
// business's connections and default brand kit; options sit behind progressive disclosure.

const INITIAL: Omit<CreateState, 'platforms' | 'brandKitId'> = {
  brief: '',
  source: 'BRIEF',
  length: 'short',
  templateId: null,
  targetAudience: '',
  callToAction: '',
  budgetPounds: '',
  reviewPolicy: '',
  projectTemplate: null,
  autoPublish: false,
  autoPublishAccounts: {},
};

const SOURCES: Array<{ key: CreateSource; label: string; icon: typeof Clapperboard }> = [
  { key: 'BRIEF', label: 'Video', icon: Clapperboard },
  { key: 'SLIDESHOW', label: 'Slideshow', icon: Layers },
];

export function CreateScreen({ initialReference }: { initialReference: Reference | null }) {
  const router = useRouter();
  const { businessId, ready } = useBusiness();
  const [form, setForm] = useState(INITIAL);
  const [platforms, setPlatforms] = useState<string[] | null>(null);
  const [brandKitId, setBrandKitId] = useState<string | null | undefined>(undefined);
  const [reference, setReference] = useState<Reference | null>(initialReference);
  const [showOptions, setShowOptions] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const kits = useApi<{ data: BrandKit[] }>(businessId ? '/brand-kits' : null, { businessId });
  const connections = useApi<{ data: PlatformConnection[] }>('/platform-connections');
  const templates = useApi<{ data: ProjectTemplate[] }>('/templates');

  const state: CreateState = {
    ...form,
    platforms: platforms ?? defaultPlatforms(connections.data?.data, businessId),
    brandKitId:
      brandKitId === undefined
        ? (kits.data?.data.find((k) => k.isDefault)?.id ?? null)
        : brandKitId,
  };

  const patch = (next: Partial<CreateState>) => {
    const { platforms: p, brandKitId: kit, ...rest } = next;
    if (p) setPlatforms(p);
    if (kit !== undefined) setBrandKitId(kit);
    setForm((f) => ({ ...f, ...rest }));
    setProblems([]);
  };

  if (ready && !businessId) {
    return (
      <EmptyState
        icon={<Building2 className="size-8" strokeWidth={1.5} />}
        title="Pick a business first"
        description="Videos are made for one business at a time. Choose it in the top bar, then come back."
        action={
          <Button asChild variant="outline">
            <Link href="/business">Set up a business</Link>
          </Button>
        }
      />
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = validateCreate(state, businessId);
    if (found.length || !businessId) {
      setProblems(found);
      return;
    }
    setSubmitting(true);
    try {
      const body = buildCreateBody(state, businessId, form.source === 'BRIEF' ? reference : null);
      const { project } = await api<{ project: Project }>('/projects', {
        method: 'POST',
        body,
        idempotencyKey: newIdempotencyKey(),
      });
      if (body.sourceType === 'SLIDESHOW') {
        toast.success('Slideshow drafted — check the slides, then generate.');
      } else {
        try {
          await api(`/projects/${project.id}/generate`, {
            method: 'POST',
            body: {},
            idempotencyKey: newIdempotencyKey(),
          });
          toast.success('Generating — Studio is writing the script.');
        } catch (err) {
          toast.error(`Saved as a draft, but generation didn’t start: ${errorMessage(err)}`);
        }
      }
      router.push(`/projects/${project.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setSubmitting(false);
    }
  }

  const isSlideshow = form.source === 'SLIDESHOW';
  const templated = usesTemplate(state, reference);
  const chooseTemplate = (id: string | null) => {
    const t = templates.data?.data.find((x) => x.id === id);
    patch({
      projectTemplate: t
        ? { id: t.id, name: t.name, platforms: t.targetFormats.map((f) => f.platform) }
        : null,
    });
  };
  return (
    <form onSubmit={submit} className="mx-auto flex max-w-3xl flex-col gap-6 pt-4 md:pt-10">
      <div>
        <p className="mb-3 text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
          Create
        </p>
        <label htmlFor="create-brief" className="font-display text-4xl leading-tight md:text-6xl">
          {isSlideshow ? 'What’s the slideshow about?' : 'What’s the video about?'}
        </label>
      </div>
      {reference && !isSlideshow && (
        <ReferenceBanner
          reference={reference}
          onModeChange={(mode) => setReference({ ...reference, mode })}
          onClear={() => setReference(null)}
        />
      )}
      <div className="rounded-2xl border border-border bg-card p-2 shadow-[0_1px_0_rgb(0_0_0/0.03)] focus-within:border-ring">
        <textarea
          id="create-brief"
          value={form.brief}
          maxLength={BRIEF_MAX}
          rows={5}
          autoFocus
          onChange={(e) => patch({ brief: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
              e.currentTarget.form?.requestSubmit();
          }}
          placeholder="Our spring menu launches Friday — three new small plates, 20% off for the first week…"
          className="block w-full resize-y bg-transparent px-3 py-2 text-lg leading-relaxed outline-none placeholder:text-muted-foreground/70"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-2 pt-2">
          <button
            type="button"
            aria-expanded={showOptions}
            aria-controls="create-options"
            onClick={() => setShowOptions((v) => !v)}
            className="rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {templated && form.projectTemplate
              ? `${form.projectTemplate.name} template`
              : `${state.platforms.length} platform${state.platforms.length === 1 ? '' : 's'} · ${
                  form.length === 'short' ? 'Short' : 'Long'
                }`}
            {form.autoPublish ? ' · auto-publish' : ''}
            {state.brandKitId ? ' · brand kit on' : ''} · <span className="underline">Options</span>
          </button>
          <Button type="submit" size="lg" disabled={submitting || !ready} className="px-4">
            {submitting ? <Loader2 className="animate-spin" /> : <ArrowRight />}
            {isSlideshow ? 'Create slideshow' : 'Generate'}
          </Button>
        </div>
      </div>
      {problems.length > 0 && (
        <ul role="alert" className="flex flex-col gap-1 text-sm text-destructive">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {showOptions && (
        <div id="create-options" className="flex flex-col gap-5">
          <div role="radiogroup" aria-label="What to make" className="flex gap-1.5">
            {SOURCES.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={form.source === key}
                onClick={() => patch({ source: key })}
                className={cn(
                  'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  form.source === key
                    ? 'border-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-4" strokeWidth={1.5} /> {label}
              </button>
            ))}
          </div>
          {isSlideshow && (
            <TemplatePicker
              value={form.templateId}
              onChange={(templateId) => patch({ templateId })}
            />
          )}
          {!isSlideshow && !reference && (
            <ProjectTemplatePicker
              templates={templates.data?.data}
              error={templates.error}
              onRetry={() => void templates.mutate()}
              value={form.projectTemplate?.id ?? null}
              onChange={chooseTemplate}
            />
          )}
          {templated ? (
            <p className="text-xs text-muted-foreground">
              Platforms and length come from the template. Your text above is optional — it adds
              specifics to the template’s outline.
            </p>
          ) : (
            <PlatformChips value={state.platforms} onChange={patch} />
          )}
          <div className="grid gap-5 sm:grid-cols-2">
            {!templated && <LengthToggle value={form.length} onChange={patch} />}
            <BrandKitSelect kits={kits.data?.data} value={state.brandKitId} onChange={patch} />
          </div>
          {!isSlideshow && (
            <AutoPublishOption
              enabled={form.autoPublish}
              onToggle={(autoPublish) => patch({ autoPublish })}
              platforms={publishPlatforms(state)}
              accounts={form.autoPublishAccounts}
              onAccount={(platform, connectionId) =>
                patch({
                  autoPublishAccounts: { ...form.autoPublishAccounts, [platform]: connectionId },
                })
              }
              connections={connections.data?.data}
              businessId={businessId}
            />
          )}
          <AdvancedOptions
            state={state}
            onChange={patch}
            open={showAdvanced}
            onToggle={() => setShowAdvanced((v) => !v)}
          />
        </div>
      )}
    </form>
  );
}
