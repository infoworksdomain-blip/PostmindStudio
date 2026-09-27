'use client';

import { ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { formatPence, PLATFORM_LABEL } from '@/lib/client/format';
import type { BrandKit } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { Field, NativeSelect } from '../review/field';
import type { CreateState, ReviewPolicy } from './body';
import {
  DEFAULT_LONG_FORM_BUDGET_PENCE,
  DEFAULT_SHORT_FORM_BUDGET_PENCE,
  defaultProjectBudgetPence,
} from '@/lib/studio/cost/project-budget';
import { buildFormats, PLATFORM_OPTIONS, type Length } from './formats';

// The three low-friction defaults (platforms, length, brand kit) plus the collapsed advanced
// options of spec 14.1. Everything here has a sensible default, so Generate works untouched.

type Patch = (patch: Partial<CreateState>) => void;

/** The budget the server applies when the field is left blank (cost/project-budget.ts). A
 *  template's formats are only known server-side, so its placeholder names both defaults. */
function budgetPlaceholder(state: CreateState): string {
  if (state.projectTemplate) {
    return `Default ${formatPence(DEFAULT_SHORT_FORM_BUDGET_PENCE)} / ${formatPence(DEFAULT_LONG_FORM_BUDGET_PENCE)}`;
  }
  return `Default ${formatPence(defaultProjectBudgetPence(buildFormats(state.platforms, state.length)))}`;
}

function Chip({
  checked,
  onToggle,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  children: string;
}) {
  return (
    <label
      className={cn(
        'inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring',
        checked
          ? 'border-foreground bg-foreground text-background'
          : 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground',
      )}
    >
      <input type="checkbox" className="sr-only" checked={checked} onChange={onToggle} />
      {children}
    </label>
  );
}

export function PlatformChips({ value, onChange }: { value: string[]; onChange: Patch }) {
  const toggle = (platform: string) =>
    onChange({
      platforms: value.includes(platform)
        ? value.filter((p) => p !== platform)
        : [...value, platform],
    });
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-medium text-muted-foreground">Platforms</legend>
      <div className="flex flex-wrap gap-1.5">
        {PLATFORM_OPTIONS.map((o) => (
          <Chip
            key={o.platform}
            checked={value.includes(o.platform)}
            onToggle={() => toggle(o.platform)}
          >
            {PLATFORM_LABEL[o.platform] ?? o.platform}
          </Chip>
        ))}
      </div>
    </fieldset>
  );
}

export function LengthToggle({ value, onChange }: { value: Length; onChange: Patch }) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-medium text-muted-foreground">Length</legend>
      <div className="flex gap-1.5">
        {(['short', 'long'] as const).map((l) => (
          <Chip key={l} checked={value === l} onToggle={() => onChange({ length: l })}>
            {l === 'short' ? 'Short' : 'Long'}
          </Chip>
        ))}
      </div>
    </fieldset>
  );
}

export function BrandKitSelect({
  kits,
  value,
  onChange,
}: {
  kits: BrandKit[] | undefined;
  value: string | null;
  onChange: Patch;
}) {
  return (
    <Field id="create-brand-kit" label="Brand kit">
      <NativeSelect
        id="create-brand-kit"
        value={value ?? ''}
        disabled={!kits}
        onChange={(e) => onChange({ brandKitId: e.target.value || null })}
      >
        <option value="">{kits ? 'No brand kit' : 'Loading…'}</option>
        {kits?.map((k) => (
          <option key={k.id} value={k.id}>
            {k.name}
            {k.isDefault ? ' (default)' : ''}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

export function AdvancedOptions({
  state,
  onChange,
  open,
  onToggle,
}: {
  state: CreateState;
  onChange: Patch;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-t border-border/70 pt-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="create-advanced"
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
        Advanced options
      </button>
      {open && (
        <div id="create-advanced" className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field id="create-audience" label="Target audience">
            <Input
              id="create-audience"
              maxLength={500}
              value={state.targetAudience}
              disabled={state.source === 'SLIDESHOW'}
              onChange={(e) => onChange({ targetAudience: e.target.value })}
              placeholder="e.g. first-time home buyers"
            />
          </Field>
          <Field id="create-cta" label="Call to action">
            <Input
              id="create-cta"
              maxLength={200}
              value={state.callToAction}
              disabled={state.source === 'SLIDESHOW'}
              onChange={(e) => onChange({ callToAction: e.target.value })}
              placeholder="e.g. Book a free consultation"
            />
          </Field>
          <Field
            id="create-budget"
            label="Budget cap (£)"
            hint={`Generation pauses at 90% of this; you can raise it on the project page. Blank = ${formatPence(DEFAULT_SHORT_FORM_BUDGET_PENCE)} for short videos, ${formatPence(DEFAULT_LONG_FORM_BUDGET_PENCE)} for long-form (over 3 minutes, or YouTube over 1 minute).`}
          >
            <Input
              id="create-budget"
              inputMode="decimal"
              value={state.budgetPounds}
              onChange={(e) => onChange({ budgetPounds: e.target.value })}
              placeholder={budgetPlaceholder(state)}
            />
          </Field>
          <Field id="create-review" label="Approval">
            <NativeSelect
              id="create-review"
              value={state.reviewPolicy}
              onChange={(e) => onChange({ reviewPolicy: e.target.value as ReviewPolicy | '' })}
            >
              <option value="">Organisation default</option>
              <option value="REQUIRE_APPROVAL">Review before publishing</option>
              <option value="AUTO_APPROVE">Approve automatically</option>
            </NativeSelect>
          </Field>
        </div>
      )}
    </div>
  );
}
