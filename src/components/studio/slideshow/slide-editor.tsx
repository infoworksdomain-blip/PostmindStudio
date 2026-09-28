'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field, NativeSelect } from '../review/field';
import { VideoUploadField } from '../uploads/video-upload-field';
import { ImagePicker } from './image-picker';
import { SLIDE_TYPES, TRANSITIONS, type Slide, type SlideContent, type SlideType } from './types';

// Edit one slide (PATCH /slides/:id): type, the content fields that type renders, image,
// duration and transition; 13.5: a VIDEO_CLIP slide uploads its clip. Only changed fields are
// sent.

const IMAGE_TYPES = new Set<SlideType>(['IMAGE_STILL', 'IMAGE_KENBURNS', 'PRODUCT']);

export interface SlidePatch {
  slideType?: SlideType;
  durationSec?: number;
  transitionIn?: string | null;
  backgroundColor?: string | null;
  imageAssetId?: string | null;
  videoAssetId?: string | null;
  content?: SlideContent;
}

interface Form {
  slideType: SlideType;
  durationSec: string;
  transitionIn: string;
  backgroundColor: string;
  imageAssetId: string | null;
  videoAssetId: string | null;
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
    videoAssetId: slide.videoAssetId,
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
  if (form.videoAssetId !== before.videoAssetId) patch.videoAssetId = form.videoAssetId;
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
  const t = useTranslations('slideshow.editor');
  const tt = useTranslations('slideshow.types');
  const tr = useTranslations('slideshow.transitions');
  const [clipName, setClipName] = useState<string | null>(null);
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
      <Field id={id('type')} label={t('type')}>
        <NativeSelect
          id={id('type')}
          value={type}
          onChange={(e) => set({ slideType: e.target.value as SlideType })}
        >
          {SLIDE_TYPES.map((slideType) => (
            <option key={slideType} value={slideType}>
              {tt(slideType)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id={id('duration')} label={t('seconds')}>
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
        <Field id={id('transition')} label={t('transition')}>
          <NativeSelect
            id={id('transition')}
            value={form.transitionIn}
            onChange={(e) => set({ transitionIn: e.target.value })}
          >
            <option value="">{tr('default')}</option>
            {TRANSITIONS.map((transition) => (
              <option key={transition} value={transition}>
                {tr(transition)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      {type === 'QUOTE' && (
        <>
          {text('quote', t('quote'), 500, true)}
          {text('author', t('author'), 120)}
        </>
      )}
      {type === 'STATISTIC' && (
        <>
          {text('value', t('value'), 40)}
          {text('label', t('label'), 120)}
        </>
      )}
      {type === 'PRODUCT' && (
        <>
          {text('name', t('productName'), 120)}
          {text('price', t('price'), 40)}
          <Field id={id('features')} label={t('features')} className="sm:col-span-2">
            <Input
              id={id('features')}
              value={form.features}
              onChange={(e) => set({ features: e.target.value })}
            />
          </Field>
        </>
      )}
      {!['QUOTE', 'STATISTIC', 'PRODUCT'].includes(type) && text('text', t('text'), 300, true)}
      {IMAGE_TYPES.has(type) && text('caption', t('caption'), 300)}
      {type === 'TEXT_CARD' && (
        <Field id={id('bg')} label={t('background')}>
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
          <span className="text-xs font-medium text-muted-foreground">{t('image')}</span>
          <ImagePicker
            businessId={businessId}
            label={t('slideImage')}
            value={form.imageAssetId}
            onChange={(imageAssetId) => set({ imageAssetId })}
          />
        </div>
      )}
      {type === 'VIDEO_CLIP' && (
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-xs font-medium text-muted-foreground">
            {form.videoAssetId
              ? clipName
                ? t('clipNamed', { name: clipName })
                : t('clipChosen')
              : t('clipNone')}
          </span>
          <VideoUploadField
            id={id('clip')}
            label={form.videoAssetId ? t('replaceClip') : t('uploadClip')}
            kind="slide_clip"
            projectId={slide.projectId}
            onUploaded={(result) => {
              if (!result.asset) return;
              setClipName(result.upload.fileName);
              set({ videoAssetId: result.asset.id });
            }}
          />
        </div>
      )}
      <div className="sm:col-span-2">
        <Button type="submit" size="sm" disabled={saving || Object.keys(patch).length === 0}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />} {t('save')}
        </Button>
      </div>
    </form>
  );
}
