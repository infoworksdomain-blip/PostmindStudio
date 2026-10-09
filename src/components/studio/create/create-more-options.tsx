'use client';

import { useId, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { BrandKit } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import type { ProjectTemplate } from '../automation/automation';
import { BusinessHashtagsNote } from '../hashtags/business-hashtags-panel';
import type { CreateState, QualityTier } from './body';
import {
  ApprovalSelect,
  BrandKitSelect,
  BudgetField,
  LengthToggle,
  MessageFields,
  PlatformChips,
} from './create-options';
import {
  LanguageOptions,
  ScheduleField,
  TierSelect,
  WorkflowSelect,
  type WorkflowOption,
} from './create-planning-options';
import { ProjectTemplatePicker } from './project-template-picker';

// BACKLOG 25.7 — Create's one "More options" disclosure (it replaced "· Options" and the nested
// "Advanced options"). Every earlier option is here, grouped by what it decides: where it goes
// and how long, brand and language, the message, approval and schedule, quality and budget.
// Options that do not apply to the chosen format are not rendered (same rules as before).

type Patch = (patch: Partial<CreateState>) => void;

export interface MoreOptionsProps {
  state: CreateState;
  onChange: Patch;
  open: boolean;
  onToggle: () => void;
  /** Format facts from the screen. */
  view: {
    /** A project template's formats replace the platform and length choice. */
    templated: boolean;
    /** The project template picker applies (an AI video without a reference). */
    canUseTemplate: boolean;
    /** Fixed-length formats (hook + demo, wall of text): no length choice. */
    fixedLength: boolean;
  };
  businessId: string | null;
  kits: BrandKit[] | undefined;
  templates: {
    data: ProjectTemplate[] | undefined;
    error: unknown;
    retry: () => void;
    choose: (id: string | null) => void;
  };
  planTier: QualityTier | undefined;
  workflows: WorkflowOption[] | undefined;
  canSchedule: boolean;
  showCosts: boolean;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-4 border-t border-border/70 pt-4">
      <h3 id={id} className="text-sm font-medium">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function MoreOptions(props: MoreOptionsProps) {
  const { state, onChange, open, view } = props;
  const t = useTranslations('create.screen');
  const isCarousel = state.source === 'CAROUSEL';
  return (
    <div className="@container grid gap-4">
      {/* 26.2: the Button primitive (ghost, sm), like the planner's "More options" toggle. */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="justify-self-start"
        aria-expanded={open}
        aria-controls="create-options"
        onClick={props.onToggle}
      >
        <ChevronDown
          aria-hidden
          className={cn(
            'transition-transform duration-(--duration-fast) motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
        {t('moreOptions')}
      </Button>
      {open && (
        <div id="create-options" className="grid gap-5">
          <Group title={t('groups.format')}>
            {view.canUseTemplate && (
              <ProjectTemplatePicker
                templates={props.templates.data}
                error={props.templates.error}
                onRetry={props.templates.retry}
                value={state.projectTemplate?.id ?? null}
                onChange={props.templates.choose}
              />
            )}
            {isCarousel ? null : view.templated ? (
              <p className="text-xs text-muted-foreground">{t('templatedNote')}</p>
            ) : (
              <PlatformChips value={state.platforms} onChange={onChange} />
            )}
            {!view.templated && !isCarousel && !view.fixedLength && (
              <LengthToggle value={state.length} onChange={onChange} />
            )}
            {/* 20.13: the hashtags every post carries (Business settings → Hashtags). */}
            <BusinessHashtagsNote businessId={props.businessId} />
          </Group>
          <Group title={t('groups.brand')}>
            <BrandKitSelect kits={props.kits} value={state.brandKitId} onChange={onChange} />
            <LanguageOptions state={state} onChange={onChange} />
          </Group>
          {!isCarousel && (
            <>
              <Group title={t('groups.message')}>
                <MessageFields state={state} onChange={onChange} />
              </Group>
              <Group title={t('groups.publishing')}>
                <ApprovalSelect state={state} onChange={onChange} />
                <WorkflowSelect state={state} onChange={onChange} workflows={props.workflows} />
                <ScheduleField state={state} onChange={onChange} canSchedule={props.canSchedule} />
              </Group>
              <Group title={t('groups.quality')}>
                <TierSelect state={state} onChange={onChange} planTier={props.planTier} />
                {props.showCosts && (
                  <BudgetField state={state} onChange={onChange} planTier={props.planTier} />
                )}
              </Group>
            </>
          )}
        </div>
      )}
    </div>
  );
}
