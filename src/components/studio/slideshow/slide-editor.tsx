'use client';

import { useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field, NativeSelect } from '../review/field';
import { ImagePicker } from './image-picker';
import {
  SLIDE_TYPE_LABEL,
  SLIDE_TYPES,
  TRANSITIONS,
  type Slide,
  type SlideContent,
  type SlideType,
} from './types';

// Edit one slide (PATCH /slides/:id): type, the content fields that type renders, image,
// duration and transition. Only changed fields are sent.

const IMAGE_TYPES = new Set<SlideType>(['IMAGE_STILL', 'IMAGE_KENBURNS', 'PRODUCT']);

export interface SlidePatch {
  slideType?: SlideType;
  durationSec?: number;
  transitionIn?: string | null;
  backgroundColor?: string | null;
  imageAssetId?: string | null;
  content?: SlideContent;
}

interface Form {
  slideType: SlideType;
  durationSec: string;
  transitionIn: string;
  backgroundColor: string;
  imageAssetId: string | null;
  text: string;
  caption: string;
  quote: string;
  author: string;
  value: string;
  label: string;
  name: string;
  price: string;
  features: string;
}

function toForm(slide: Slide): Form {
  const c = slide.content;
  return {
    slideType: slide.slideType,
    durationSec: String(slide.durationSec),
    transitionIn: slide.transitionIn ?? '',
    backgroundColor: slide.backgroundColor ?? '#111111',
    imageAssetId: slide.imageAssetId,
    text: c.text ?? '',
    caption: c.caption ?? '',
    quote: c.quote ?? '',
    author: c.author ?? '',
    value: c.value ?? '',
    label: c.label ?? '',
    name: c.name ?? '',
    price: c.price ?? '',
    features: (c.features ?? []).join(', '),
  };
}

const TEXT_KEYS = [
  'text',
  'caption',
  'quote',
  'author',
  'value',
  'label',
  'name',
  'price',
] as const;

/** Only what changed, in the PATCH /slides/:id shape. */
export function slidePatch(slide: Slide, form: Form): SlidePatch {
  const before = toForm(slide);
  const patch: SlidePatch = {};
  if (form.slideType !== before.slideType) patch.slideType = form.slideType;
  const duration = Number(form.durationSec);
  if (form.durationSec !== before.durationSec && Number.isFinite(duration))
    patch.durationSec = Math.min(10, Math.max(0.5, duration));
  if (form.transitionIn !== before.transitionIn) patch.transitionIn = form.transitionIn || null;
  if (form.slideType === 'TEXT_CARD' && form.backgroundColor !== before.backgroundColor)
    patch.backgroundColor = form.backgroundColor;
  if (form.imageAssetId !== before.imageAssetId) patch.imageAssetId = form.imageAssetId;
  const content: SlideContent = {};
  for (const key of TEXT_KEYS) {
    if (form[key] !== before[key]) content[key] = form[key].trim();
  }
  if (form.features !== before.features)
    content.features = form.features
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean)
      .slice(0, 4);
  if (Object.keys(content).length) patch.content = content;
  return patch;
}

export function SlideEditor({
  slide,
  businessId,
  saving,
  onSave,
}: {
  slide: Slide;
  businessId: string | null;
  saving: boolean;
  onSave: (patch: SlidePatch) => void;
}) {
  const [form, setForm] = useState<Form>(() => toForm(slide));
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const id = (name: string) => `slide-${slide.id}-${name}`;
  const patch = slidePatch(slide, form);
  const type = form.slideType;
  const text = (key: (typeof TEXT_KEYS)[number], label: string, max: number, long = false) => (
    <Field id={id(key)} label={label} className={long ? 'sm:col-span-2' : undefined}>
      {long ? (
        <Textarea
          id={id(key)}
          value={form[key]}
          maxLength={max}
          onChange={(e) => set({ [key]: e.target.value })}
        />
      ) : (
        <Input
          id={id(key)}
          value={form[key]}
          maxLength={max}
          onChange={(e) => set({ [key]: e.target.value })}
        />
      )}
    </Field>
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (Object.keys(patch).length) onSave(patch);
      }}
      className="grid gap-3 rounded-lg bg-muted/40 p-3 sm:grid-cols-2"
    >
      <Field id={id('type')} label="Slide type">
        <NativeSelect
          id={id('type')}
          value={type}
          onChange={(e) => set({ slideType: e.target.value as SlideType })}
        >
          {SLIDE_TYPES.map((t) => (
            <option key={t} value={t}>
              {SLIDE_TYPE_LABEL[t]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id={id('duration')} label="Seconds">
          <Input
            id={id('duration')}
            type="number"
            min={0.5}
            max={10}
            step={0.5}
            value={form.durationSec}
            onChange={(e) => set({ durationSec: e.target.value })}
          />
        </Field>
        <Field id={id('transition')} label="Transition in">
          <NativeSelect
            id={id('transition')}
            value={form.transitionIn}
            onChange={(e) => set({ transitionIn: e.target.value })}
          >
            <option value="">Default</option>
            {TRANSITIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      {type === 'QUOTE' && (
        <>
          {text('quote', 'Quote', 500, true)}
          {text('author', 'Author', 120)}
        </>
      )}
      {type === 'STATISTIC' && (
        <>
          {text('value', 'Value', 40)}
          {text('label', 'Label', 120)}
        </>
      )}
      {type === 'PRODUCT' && (
        <>
          {text('name', 'Product name', 120)}
          {text('price', 'Price', 40)}
          <Field
            id={id('features')}
            label="Features (comma separated, up to 4)"
            className="sm:col-span-2"
          >
            <Input
              id={id('features')}
              value={form.features}
              onChange={(e) => set({ features: e.target.value })}
            />
          </Field>
        </>
      )}
      {!['QUOTE', 'STATISTIC', 'PRODUCT'].includes(type) && text('text', 'Text', 300, true)}
      {IMAGE_TYPES.has(type) && text('caption', 'Caption', 300)}
      {type === 'TEXT_CARD' && (
        <Field id={id('bg')} label="Background colour">
          <input
            id={id('bg')}
            type="color"
            value={form.backgroundColor}
            onChange={(e) => set({ backgroundColor: e.target.value })}
            className="h-8 w-full cursor-pointer rounded-lg border border-input"
          />
        </Field>
      )}
      {IMAGE_TYPES.has(type) && businessId && (
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-xs font-medium text-muted-foreground">Image</span>
          <ImagePicker
            businessId={businessId}
            label="Slide image"
            value={form.imageAssetId}
            onChange={(imageAssetId) => set({ imageAssetId })}
          />
        </div>
      )}
      <div className="sm:col-span-2">
        <Button type="submit" size="sm" disabled={saving || Object.keys(patch).length === 0}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />} Save slide
        </Button>
      </div>
    </form>
  );
}
