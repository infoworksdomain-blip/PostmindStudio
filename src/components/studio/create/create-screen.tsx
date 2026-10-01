'use client';

import { MAX_SCHEDULE_AHEAD_DAYS } from '@/lib/studio/schedule-window';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowRight, CalendarRange, Clapperboard, Layers, Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import type { BrandKit, MetaConnectInfo, PlatformConnection, Project } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { useBusiness } from '../business-context';
import { EmptyState } from '../primitives';
import { TemplatePicker } from '../slideshow/template-picker';
import type { ProjectTemplate } from '../automation/automation';
import { AutoPublishOption } from './auto-publish-option';
import {
  BRIEF_MAX,
  buildCreateBody,
  MAX_BUDGET_POUNDS,
  buildGenerateBody,
  publishPlatforms,
  usesTemplate,
  validateCreate,
  type CreateProblem,
  type CreateSource,
  type CreateState,
  type QualityTier,
  type Reference,
} from './body';
import { defaultSourceFor, LanguageOptions, type WorkflowOption } from './create-planning-options';
import { AdvancedOptions, BrandKitSelect, LengthToggle, PlatformChips } from './create-options';
import { BusinessHashtagsNote } from '../hashtags/business-hashtags-panel';
import { defaultPlatforms } from './formats';
import { ProjectTemplatePicker } from './project-template-picker';
import { ReferenceBanner } from './reference-banner';
import { VideoUploadField } from '../uploads/video-upload-field';
import { ProfileReviewNotice } from '../business/profile-review-notice';

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
  upload: null,
};

const SOURCES: Array<{ key: CreateSource; icon: typeof Clapperboard }> = [
  { key: 'BRIEF', icon: Clapperboard },
  { key: 'SLIDESHOW', icon: Layers },
  { key: 'UPLOAD', icon: Upload },
];

const WHOLE_POUNDS: Intl.NumberFormatOptions = {
  style: 'currency',
  currency: 'GBP',
  maximumFractionDigits: 0,
};

export function CreateScreen({ initialReference }: { initialReference: Reference | null }) {
  const router = useRouter();
  const t = useTranslations('create.screen');
  const tp = useTranslations('create.problems');
  const tl = useTranslations('create.options.lengths');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const { businessId, ready } = useBusiness();
  const [form, setForm] = useState(INITIAL);
  const [platforms, setPlatforms] = useState<string[] | null>(null);
  const [brandKitId, setBrandKitId] = useState<string | null | undefined>(undefined);
  const [reference, setReference] = useState<Reference | null>(initialReference);
  const [showOptions, setShowOptions] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [problems, setProblems] = useState<CreateProblem[]>([]);

  const kits = useApi<{ data: BrandKit[] }>(businessId ? '/brand-kits' : null, { businessId });
  const connections = useApi<{ data: PlatformConnection[]; meta?: MetaConnectInfo }>(
    '/platform-connections',
  );
  const templates = useApi<{ data: ProjectTemplate[] }>('/templates');
  // 15.C4: the plan tier caps the tier override; workflows feed the approval picker (15.D3).
  const usage = useApi<{ usage: { planTier: QualityTier } }>('/usage');
  const workflows = useApi<{ data: WorkflowOption[] }>('/approval-workflows');
  const planTier = usage.data?.usage.planTier;
  const [sourceTouched, setSourceTouched] = useState(false);
  // P5 (operator decision): the Basic plan starts on Slideshow until the user picks.
  useEffect(() => {
    if (sourceTouched || initialReference) return;
    setForm((f) => ({ ...f, source: defaultSourceFor(planTier) }));
  }, [planTier, sourceTouched, initialReference]);

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
        illustration="business"
        title={t('noBusiness.title')}
        description={t('noBusiness.description')}
        action={
          <Button asChild variant="outline">
            <Link href="/business">{t('noBusiness.action')}</Link>
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
        toast.success(t('toast.slideshowDrafted'));
      } else {
        try {
          await api(`/projects/${project.id}/generate`, {
            method: 'POST',
            body: buildGenerateBody(state),
            idempotencyKey: newIdempotencyKey(),
          });
          toast.success(
            body.sourceType === 'UPLOAD'
              ? t('toast.generatingUpload')
              : t('toast.generatingScript'),
          );
        } catch (err) {
          toast.error(t('toast.draftNotStarted', { error: errorMessage(err) }));
        }
      }
      router.push(`/projects/${project.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setSubmitting(false);
    }
  }

  const isSlideshow = form.source === 'SLIDESHOW';
  const isUpload = form.source === 'UPLOAD';
  const templated = usesTemplate(state, reference);
  const chooseTemplate = (id: string | null) => {
    const found = templates.data?.data.find((x) => x.id === id);
    patch({
      projectTemplate: found
        ? {
            id: found.id,
            name: found.name,
            platforms: found.targetFormats.map((format) => format.platform),
          }
        : null,
    });
  };
  const problemText = (p: CreateProblem): string => {
    if (p === 'briefTooLong') return tp('briefTooLong', { max: BRIEF_MAX });
    if (p === 'scheduleTooFar') return tp('scheduleTooFar', { days: MAX_SCHEDULE_AHEAD_DAYS });
    if (p === 'budgetRange')
      return tp('budgetRange', {
        min: f.number(0, WHOLE_POUNDS),
        max: f.number(MAX_BUDGET_POUNDS, WHOLE_POUNDS),
      });
    return tp(p);
  };
  // The options summary: separate facts joined with a middle dot (a list, not a sentence).
  const summary = [
    templated && form.projectTemplate
      ? t('summaryTemplate', { name: form.projectTemplate.name })
      : `${t('summaryPlatforms', { count: state.platforms.length })} · ${tl(form.length)}`,
    form.autoPublish ? t('summaryAutoPublish') : null,
    state.brandKitId ? t('summaryBrandKit') : null,
  ].filter(Boolean);
  return (
    <form onSubmit={submit} className="mx-auto flex max-w-3xl flex-col gap-6 pt-4 md:pt-10">
      <div>
        <p className="mb-3 text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
          {t('eyebrow')}
        </p>
        <label htmlFor="create-brief" className="font-display text-4xl leading-tight md:text-6xl">
          {t(`heading.${form.source}`)}
        </label>
        {/* 20.9: a whole month of videos and slideshows, drafted and scheduled at once. */}
        <Link
          href="/plans/new"
          className="mt-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          <CalendarRange className="size-4" strokeWidth={1.5} /> {t('planMonth')}
        </Link>
      </div>
      {!isUpload && <ProfileReviewNotice businessId={businessId} />}
      {isUpload && businessId && (
        <div className="flex flex-col gap-1">
          <VideoUploadField
            id="create-upload"
            label={form.upload ? t('uploadReplace') : t('uploadChoose')}
            kind="source_video"
            businessId={businessId}
            onUploaded={(result) =>
              patch({ upload: { id: result.upload.id, fileName: result.upload.fileName } })
            }
          />
          <p className="text-xs text-muted-foreground">{t('uploadNote')}</p>
        </div>
      )}
      {reference && !isSlideshow && !isUpload && (
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
          placeholder={t('briefPlaceholder')}
          className="block w-full resize-y bg-transparent px-3 py-2 text-lg leading-relaxed outline-none placeholder:text-muted-foreground/70"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-2 pt-2">
          <button
            type="button"
            aria-expanded={showOptions}
            aria-controls="create-options"
            onClick={() => setShowOptions((v) => !v)}
            className="rounded-md px-1.5 py-1 text-start text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {summary.join(' · ')} · <span className="underline">{t('options')}</span>
          </button>
          <Button type="submit" size="lg" disabled={submitting || !ready} className="px-4">
            {submitting ? (
              <Loader2 className="animate-spin" />
            ) : (
              <ArrowRight className="rtl:-scale-x-100" />
            )}
            {isSlideshow ? t('createSlideshow') : t('generate')}
          </Button>
        </div>
      </div>
      {problems.length > 0 && (
        <ul role="alert" className="flex flex-col gap-1 text-sm text-destructive">
          {problems.map((p) => (
            <li key={p}>{problemText(p)}</li>
          ))}
        </ul>
      )}
      {showOptions && (
        <div id="create-options" className="flex flex-col gap-5">
          <div role="radiogroup" aria-label={t('sourcesAria')} className="flex gap-1.5">
            {SOURCES.map(({ key, icon: Icon }) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={form.source === key}
                onClick={() => {
                  setSourceTouched(true);
                  patch({ source: key });
                }}
                className={cn(
                  'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  form.source === key
                    ? 'border-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-4" strokeWidth={1.5} /> {t(`sources.${key}`)}
              </button>
            ))}
          </div>
          {isSlideshow && (
            <TemplatePicker
              value={form.templateId}
              onChange={(templateId) => patch({ templateId })}
            />
          )}
          {!isSlideshow && !isUpload && !reference && (
            <ProjectTemplatePicker
              templates={templates.data?.data}
              error={templates.error}
              onRetry={() => void templates.mutate()}
              value={form.projectTemplate?.id ?? null}
              onChange={chooseTemplate}
            />
          )}
          {templated ? (
            <p className="text-xs text-muted-foreground">{t('templatedNote')}</p>
          ) : (
            <PlatformChips value={state.platforms} onChange={patch} />
          )}
          {/* 20.13: the hashtags every post carries (Business settings → Hashtags). */}
          <BusinessHashtagsNote businessId={businessId} />
          <div className="grid gap-5 sm:grid-cols-2">
            {!templated && <LengthToggle value={form.length} onChange={patch} />}
            <BrandKitSelect kits={kits.data?.data} value={state.brandKitId} onChange={patch} />
          </div>
          <LanguageOptions state={state} onChange={patch} />
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
              metaConnect={connections.data?.meta?.connect}
              businessId={businessId}
            />
          )}
          <AdvancedOptions
            state={state}
            onChange={patch}
            open={showAdvanced}
            onToggle={() => setShowAdvanced((v) => !v)}
            planTier={planTier}
            workflows={workflows.data?.data}
          />
        </div>
      )}
    </form>
  );
}
