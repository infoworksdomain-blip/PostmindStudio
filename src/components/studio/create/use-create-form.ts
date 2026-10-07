'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { api, ApiError, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import type { BrandKit, MetaConnectInfo, PlatformConnection, Project } from '@/lib/client/types';
import { useShowCosts } from '../account/use-show-costs';
import { useCreateBlock } from '../account/create-access';
import { useBusiness } from '../business-context';
import type { UsageResponse } from '../usage-meter';
import {
  buildTargets,
  hasConnectedAccount,
  publishablePlatforms,
  resolveAccounts,
  type ProjectTemplate,
} from '../automation/automation';
import {
  buildCreateBody,
  EMPTY_HOOK_DEMO,
  EMPTY_UGC,
  EMPTY_WALL_OF_TEXT,
  publishPlatforms,
  validateCreate,
  type CreateProblem,
  type CreateSource,
  type CreateState,
  type InitialTemplate,
  type Reference,
} from './body';
import { defaultSourceFor, type WorkflowOption } from './create-planning-options';
import { defaultPlatforms, PLATFORM_OPTIONS } from './formats';
import {
  buildGenerateBody,
  modelsForTier,
  runTier,
  usesVideoModel,
  type VideoModelsResponse,
} from './generate-body';

// BACKLOG 10.3 / 25.7 — the Create screen's state, server data and submit (create-screen.tsx
// renders it). Defaults are pre-filled from the business's connections and default brand kit.

/** The form's own state; autoPublish null = the default (on when an account can post). */
export type FormState = Omit<CreateState, 'platforms' | 'brandKitId' | 'autoPublish'> & {
  autoPublish: boolean | null;
};

export type FormPatch = Partial<FormState & Pick<CreateState, 'platforms' | 'brandKitId'>>;

const INITIAL: FormState = {
  brief: '',
  source: 'BRIEF',
  length: 'short',
  templateId: null,
  targetAudience: '',
  callToAction: '',
  budgetPounds: '',
  reviewPolicy: '',
  projectTemplate: null,
  autoPublish: null,
  autoPublishAccounts: {},
  upload: null,
  ugc: EMPTY_UGC,
  hookDemo: EMPTY_HOOK_DEMO,
  wallOfText: EMPTY_WALL_OF_TEXT,
  videoModel: null,
};

function useCreateData(businessId: string | null) {
  return {
    kits: useApi<{ data: BrandKit[] }>(businessId ? '/brand-kits' : null, { businessId }),
    connections: useApi<{ data: PlatformConnection[]; meta?: MetaConnectInfo }>(
      '/platform-connections',
    ),
    templates: useApi<{ data: ProjectTemplate[] }>('/templates'),
    // 15.C4: the plan tier caps the tier override; 25.7: the allowance line reads the meters.
    usage: useApi<UsageResponse>('/usage'),
    workflows: useApi<{ data: WorkflowOption[] }>('/approval-workflows'),
    // 25.8: the AI-clip models this organisation can pick.
    videoModels: useApi<VideoModelsResponse>('/video-models'),
  };
}

export function useCreateForm(
  initialReference: Reference | null,
  initialTemplate: InitialTemplate | null,
) {
  const router = useRouter();
  const t = useTranslations('create.screen');
  const errorMessage = useErrorMessage();
  const { businessId, ready } = useBusiness();
  const [form, setForm] = useState<FormState>(() =>
    initialTemplate?.kind === 'slideshow'
      ? { ...INITIAL, source: 'SLIDESHOW', templateId: initialTemplate.id }
      : INITIAL,
  );
  const [platforms, setPlatforms] = useState<string[] | null>(null);
  const [brandKitId, setBrandKitId] = useState<string | null | undefined>(undefined);
  const [reference, setReference] = useState<Reference | null>(initialReference);
  const [moreOpen, setMoreOpen] = useState(initialTemplate !== null);
  const [submitting, setSubmitting] = useState(false);
  const [problems, setProblems] = useState<CreateProblem[]>([]);
  // 21.4: the server refused a UGC brief that asks for a real person.
  const [refusal, setRefusal] = useState(false);
  // Read-only: every mutation answers 402, so Generate is disabled with the reason beside it.
  const block = useCreateBlock();
  const data = useCreateData(businessId);
  const planTier = data.usage.data?.usage?.planTier;
  const showCosts = useShowCosts();

  // "Use template" on /templates: pick that project template once the list is here (a template
  // deleted meanwhile is simply not applied).
  const [templateApplied, setTemplateApplied] = useState(false);
  useEffect(() => {
    if (templateApplied || initialTemplate?.kind !== 'project' || !data.templates.data) return;
    setTemplateApplied(true);
    const found = data.templates.data.data.find((x) => x.id === initialTemplate.id);
    if (!found) return;
    setForm((f) => ({
      ...f,
      projectTemplate: {
        id: found.id,
        name: found.name,
        platforms: found.targetFormats.map((format) => format.platform),
      },
    }));
  }, [templateApplied, initialTemplate, data.templates.data]);
  const [sourceTouched, setSourceTouched] = useState(initialTemplate?.kind === 'slideshow');
  // P5 (operator decision): the Basic plan starts on Slideshow until the user picks.
  useEffect(() => {
    if (sourceTouched || initialReference) return;
    setForm((f) => ({ ...f, source: defaultSourceFor(planTier) }));
  }, [planTier, sourceTouched, initialReference]);

  const chosen: CreateState = {
    ...form,
    autoPublish: false,
    platforms: platforms ?? defaultPlatforms(data.connections.data?.data, businessId),
    brandKitId:
      brandKitId === undefined
        ? (data.kits.data?.data.find((k) => k.isDefault)?.id ?? null)
        : brandKitId,
  };
  // 20.12: "platforms" are the formats to render; "accounts" are the connected social accounts
  // the result is posted to. Auto-publish defaults on only when an account can post one of the
  // chosen platforms, and is always off for a business with no connected account.
  const connectionList = data.connections.data?.data;
  const hasAccounts = hasConnectedAccount(connectionList, businessId);
  const publishable = publishablePlatforms(
    PLATFORM_OPTIONS.map((o) => o.platform),
    connectionList,
    businessId,
  );
  const accounts = resolveAccounts(
    publishPlatforms(chosen),
    form.autoPublishAccounts,
    connectionList,
    businessId,
  );
  const autoPublish =
    hasAccounts &&
    (form.autoPublish ?? buildTargets(publishPlatforms(chosen), accounts).length > 0);
  const state: CreateState = { ...chosen, autoPublish, autoPublishAccounts: accounts };
  // 25.8: the models the server accepts on this run's tier.
  const videoModels = modelsForTier(data.videoModels.data?.models, runTier(state, planTier));
  const offered = videoModels.map((m) => m.providerId);

  const patch = (next: FormPatch) => {
    const { platforms: p, brandKitId: kit, ...rest } = next;
    if (p) setPlatforms(p);
    if (kit !== undefined) setBrandKitId(kit);
    setForm((f) => ({ ...f, ...rest }));
    setProblems([]);
    setRefusal(false);
  };

  const chooseSource = (source: CreateSource) => {
    setSourceTouched(true);
    patch({ source });
  };

  const chooseTemplate = (id: string | null) => {
    const found = data.templates.data?.data.find((x) => x.id === id);
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

  async function startGeneration(project: Project, sourceType: string) {
    try {
      await api(`/projects/${project.id}/generate`, {
        method: 'POST',
        body: buildGenerateBody(state, offered),
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(
        sourceType === 'UPLOAD'
          ? t('toast.generatingUpload')
          : sourceType === 'CAROUSEL'
            ? t('toast.generatingCarousel')
            : sourceType === 'HOOK_DEMO' || sourceType === 'WALL_OF_TEXT'
              ? t('toast.generatingFormat')
              : t('toast.generatingScript'),
      );
    } catch (err) {
      toast.error(t('toast.draftNotStarted', { error: errorMessage(err) }));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = validateCreate(state, businessId, Date.now(), publishable);
    if (found.length || !businessId) {
      setProblems(found);
      return;
    }
    setSubmitting(true);
    try {
      const body = buildCreateBody(state, businessId, form.source === 'BRIEF' ? reference : null);
      setRefusal(false);
      const { project } = await api<{ project: Project }>('/projects', {
        method: 'POST',
        body,
        idempotencyKey: newIdempotencyKey(),
      });
      if (body.sourceType === 'SLIDESHOW') toast.success(t('toast.slideshowDrafted'));
      else await startGeneration(project, body.sourceType);
      router.push(`/projects/${project.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.details?.reason === 'ugc_real_person_refused')
        setRefusal(true);
      // 22.1: the business has no (usable) demo video: say so beside the form.
      else if (err instanceof ApiError && err.code === 'no_demo_video')
        setProblems(['demoRequired']);
      else toast.error(errorMessage(err));
      setSubmitting(false);
    }
  }

  return {
    ready,
    businessId,
    form,
    state,
    patch,
    chooseSource,
    chooseTemplate,
    reference,
    setReference,
    moreOpen,
    toggleMore: () => setMoreOpen((v) => !v),
    submitting,
    problems,
    refusal,
    block,
    data,
    planTier,
    showCosts,
    hasAccounts,
    publishable,
    accounts,
    connectionList,
    videoModels,
    showVideoModel: usesVideoModel(state),
    droppedVideoModel:
      Boolean(state.videoModel && data.videoModels.data) &&
      !offered.includes(state.videoModel ?? ''),
    /** P5: the Basic plan started on Slideshow and the user has not picked a format yet. */
    basicDefault:
      !sourceTouched && !initialReference && planTier === 'BASIC' && form.source === 'SLIDESHOW',
    submit,
  };
}

export type CreateForm = ReturnType<typeof useCreateForm>;
