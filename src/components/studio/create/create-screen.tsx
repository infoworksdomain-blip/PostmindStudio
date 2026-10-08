'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CalendarRange } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '../primitives';
import { TemplatePicker } from '../slideshow/template-picker';
import { VideoUploadField } from '../uploads/video-upload-field';
import { ProfileReviewNotice } from '../business/profile-review-notice';
import { BriefHint, briefHintDescribedBy } from '../brief-hint';
import { AutoPublishOption } from './auto-publish-option';
import {
  BRIEF_MAX,
  EMPTY_HOOK_DEMO,
  EMPTY_UGC,
  EMPTY_WALL_OF_TEXT,
  publishPlatforms,
  type InitialTemplate,
  type Reference,
} from './body';
import { CarouselOptions } from './carousel-options';
import { CreateActionBar } from './create-action-bar';
import { allowanceLine } from './create-allowance';
import { MoreOptions } from './create-more-options';
import { useCreateText } from './create-summary';
import { FormatRail } from './format-rail';
import { HookDemoOptions } from './hook-demo-options';
import { ReferenceBanner } from './reference-banner';
import { ReferencePreview } from './reference-preview';
import { UgcOptions } from './ugc-options';
import { useCreateForm, type CreateForm } from './use-create-form';
import { VideoModelPicker } from './video-model-picker';
import { WallOfTextOptions } from './wall-of-text-options';

// BACKLOG 10.3 / 25.7 — Create (spec 14.1): the format first (a visible rail of the seven
// formats), then one calm brief, then the options a format needs. Everything else waits behind
// one "More options" disclosure, beside the brief on wide screens (sticky) and below it on phones,
// where Generate stays in thumb reach. Ctrl/⌘ + Enter in the brief submits.

export function CreateScreen({
  initialReference,
  initialTemplate = null,
}: {
  initialReference: Reference | null;
  /** A template picked on /templates: applied once its list has loaded. */
  initialTemplate?: InitialTemplate | null;
}) {
  const t = useTranslations('create.screen');
  const c = useCreateForm(initialReference, initialTemplate);
  const text = useCreateText(c);

  if (c.ready && !c.businessId) {
    return (
      <EmptyState
        media="business"
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

  const { form, state, patch } = c;
  return (
    <form
      onSubmit={c.submit}
      className="mx-auto grid max-w-6xl gap-x-10 gap-y-7 pt-4 md:pt-8 xl:grid-cols-[minmax(0,1fr)_22rem]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 xl:col-span-2">
        <h1 className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
          {t('eyebrow')}
        </h1>
        {/* 20.9: a whole month of videos and slideshows, drafted and scheduled at once. */}
        <Link
          href="/plans/new"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          <CalendarRange className="size-4" strokeWidth={1.5} aria-hidden /> {t('planMonth')}
        </Link>
      </div>
      <div className="min-w-0 xl:col-span-2">
        <FormatRail
          value={form.source}
          onChange={c.chooseSource}
          note={c.basicDefault ? t('basicDefault') : null}
        />
      </div>
      <BriefColumn c={c} />
      {/* xl: the options column scrolls on its own while Generate stays pinned at its foot. */}
      <div className="grid min-w-0 content-start gap-6 xl:sticky xl:top-6 xl:max-h-[calc(100dvh-3rem)] xl:self-start xl:overflow-y-auto xl:pe-1 xl:pb-px">
        {c.showVideoModel && (
          <VideoModelPicker
            source={form.source}
            models={c.videoModels}
            value={state.videoModel}
            onChange={(videoModel) => patch({ videoModel })}
            showCosts={c.showCosts}
            droppedChoice={c.droppedVideoModel}
          />
        )}
        <MoreOptions
          state={state}
          onChange={patch}
          open={c.moreOpen}
          onToggle={c.toggleMore}
          view={{
            templated: text.templated,
            canUseTemplate: form.source === 'BRIEF' && !c.reference,
            fixedLength: form.source === 'HOOK_DEMO' || form.source === 'WALL_OF_TEXT',
          }}
          businessId={c.businessId}
          kits={c.data.kits.data?.data}
          templates={{
            data: c.data.templates.data?.data,
            error: c.data.templates.error,
            retry: () => void c.data.templates.mutate(),
            choose: c.chooseTemplate,
          }}
          planTier={c.planTier}
          workflows={c.data.workflows.data?.data}
          canSchedule={!c.data.connections.data || c.publishable.length > 0}
          showCosts={c.showCosts}
        />
        <CreateActionBar
          source={form.source}
          summary={text.summary}
          allowance={allowanceLine(state, c.data.usage.data?.usage)}
          submitting={c.submitting}
          disabled={!c.ready || c.block === 'read_only'}
          block={c.block}
        />
      </div>
    </form>
  );
}

/** The heading, the brief and the chosen format's own settings. */
function BriefColumn({ c }: { c: CreateForm }) {
  const t = useTranslations('create.screen');
  const tp = useTranslations('create.problems');
  const text = useCreateText(c);
  const { form, state, patch, reference, businessId } = c;
  const isUpload = form.source === 'UPLOAD';
  const showReference = reference && form.source === 'BRIEF';
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <label
        htmlFor="create-brief"
        className="font-display text-3xl leading-tight text-balance md:text-5xl"
      >
        {t(`heading.${form.source}`)}
      </label>
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
      {showReference && (
        <>
          <ReferenceBanner
            reference={reference}
            onModeChange={(mode) => c.setReference({ ...reference, mode })}
            onClear={() => c.setReference(null)}
          />
          <ReferencePreview id={reference.id} mode={reference.mode} />
        </>
      )}
      <div className="rounded-2xl border border-border bg-card p-1.5 shadow-[0_1px_0_rgb(0_0_0/0.03)] transition-[border-color] duration-(--duration-fast) focus-within:border-ring">
        <textarea
          id="create-brief"
          value={form.brief}
          maxLength={BRIEF_MAX}
          rows={7}
          autoFocus
          onChange={(e) => patch({ brief: e.target.value })}
          aria-describedby={briefHintDescribedBy(form.brief, 'create-brief-hint')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
              e.currentTarget.form?.requestSubmit();
          }}
          placeholder={t('briefPlaceholder')}
          className="block min-h-44 w-full resize-y bg-transparent px-4 py-3 text-lg leading-relaxed outline-none placeholder:text-muted-foreground/70"
        />
        <p className="px-4 pb-2 text-end text-xs text-muted-foreground" aria-hidden>
          {t('submitShortcut')}
        </p>
      </div>
      {/* 20.18: a gentle nudge for a very short or generic brief; Generate still works. */}
      <BriefHint text={form.brief} id="create-brief-hint" className="-mt-2" />
      {form.source !== 'CAROUSEL' && (
        <AutoPublishOption
          source={form.source}
          enabled={state.autoPublish}
          onToggle={(on) => patch({ autoPublish: on })}
          platforms={publishPlatforms(state)}
          accounts={c.accounts}
          onAccount={(platform, connectionId) =>
            patch({
              autoPublishAccounts: { ...form.autoPublishAccounts, [platform]: connectionId },
              // Picking accounts settles the toggle: un-picking them all asks, never silently stops.
              autoPublish: form.autoPublish ?? state.autoPublish,
            })
          }
          connections={c.connectionList}
          metaConnect={c.data.connections.data?.meta?.connect}
          businessId={businessId}
        />
      )}
      {form.source === 'SLIDESHOW' && (
        <TemplatePicker value={form.templateId} onChange={(templateId) => patch({ templateId })} />
      )}
      {form.source === 'CAROUSEL' && <CarouselOptions state={form} onChange={patch} />}
      {form.source === 'UGC' && (
        <UgcOptions
          businessId={businessId}
          value={form.ugc ?? EMPTY_UGC}
          onChange={(ugc) => patch({ ugc })}
        />
      )}
      {form.source === 'HOOK_DEMO' && (
        <HookDemoOptions
          businessId={businessId}
          value={form.hookDemo ?? EMPTY_HOOK_DEMO}
          onChange={(hookDemo) => patch({ hookDemo })}
        />
      )}
      {form.source === 'WALL_OF_TEXT' && (
        <WallOfTextOptions
          value={form.wallOfText ?? EMPTY_WALL_OF_TEXT}
          onChange={(wallOfText) => patch({ wallOfText })}
        />
      )}
      {c.refusal && (
        <p role="alert" className="text-sm text-destructive">
          {tp('ugcRealPerson')}
        </p>
      )}
      {c.problems.length > 0 && (
        <ul role="alert" className="flex flex-col gap-1 text-sm text-destructive">
          {c.problems.map((p) => (
            <li key={p}>{text.problemText(p)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
