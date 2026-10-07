'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/ui/native-select';
import { Field } from '../review/field';
import { ColourField } from './colour-field';
import { snapAnchor } from './overlay-math';
import { ALIGNMENTS, ANIMATIONS, BACKGROUND_TYPES, type Overlay, type OverlayDraft } from './types';

// The style panel for one overlay (A4.1): text, timing, typography, colour, background,
// position and animation. Every change is a local draft; the parent saves it. Colours carry an
// opacity (13.7).

const WEIGHTS = [300, 400, 500, 600, 700, 800, 900];

function num(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function OverlayForm({
  overlay,
  duration,
  disabled,
  onDraft,
}: {
  overlay: Overlay;
  duration: number;
  disabled: boolean;
  onDraft: (patch: OverlayDraft) => void;
}) {
  const t = useTranslations('overlays.form');
  const id = (name: string) => `ov-${overlay.id}-${name}`;
  return (
    <fieldset disabled={disabled} className="grid min-w-0 grid-cols-2 gap-3">
      <legend className="sr-only">{t('legend')}</legend>
      <Field id={id('text')} label={t('text')} className="col-span-2">
        <Textarea
          id={id('text')}
          value={overlay.text}
          maxLength={500}
          rows={2}
          onChange={(e) => onDraft({ text: e.target.value })}
        />
      </Field>
      <Field id={id('start')} label={t('start')}>
        <Input
          id={id('start')}
          type="number"
          step={0.1}
          min={0}
          max={duration}
          value={overlay.startAtSec}
          onChange={(e) => onDraft({ startAtSec: num(e.target.value, overlay.startAtSec) })}
        />
      </Field>
      <Field id={id('end')} label={t('end')}>
        <Input
          id={id('end')}
          type="number"
          step={0.1}
          min={0}
          max={duration}
          value={overlay.endAtSec}
          onChange={(e) => onDraft({ endAtSec: num(e.target.value, overlay.endAtSec) })}
        />
      </Field>
      <Field id={id('font')} label={t('font')}>
        <Input
          id={id('font')}
          value={overlay.fontFamily}
          maxLength={64}
          onChange={(e) => onDraft({ fontFamily: e.target.value })}
        />
      </Field>
      <Field id={id('weight')} label={t('weight')}>
        <NativeSelect
          id={id('weight')}
          value={overlay.fontWeight}
          onChange={(e) => onDraft({ fontWeight: Number(e.target.value) })}
        >
          {WEIGHTS.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id={id('size')} label={t('size', { pct: overlay.fontSizePct })}>
        <input
          id={id('size')}
          type="range"
          min={1}
          max={40}
          step={0.5}
          value={overlay.fontSizePct}
          onChange={(e) => onDraft({ fontSizePct: Number(e.target.value) })}
          className="accent-primary"
        />
      </Field>
      <Field id={id('fill')} label={t('textColour')}>
        <ColourField
          id={id('fill')}
          value={overlay.fillColor}
          fallback="#ffffff"
          onChange={(fillColor) => onDraft({ fillColor })}
        />
      </Field>
      <Field id={id('bg')} label={t('background')}>
        <NativeSelect
          id={id('bg')}
          value={overlay.backgroundType}
          onChange={(e) =>
            onDraft({
              backgroundType: e.target.value,
              ...(e.target.value !== 'none' &&
                !overlay.backgroundColor && { backgroundColor: '#000000' }),
            })
          }
        >
          {BACKGROUND_TYPES.map((b) => (
            <option key={b} value={b}>
              {t(`backgrounds.${b}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id={id('bgc')} label={t('backgroundColour')}>
        <ColourField
          id={id('bgc')}
          value={overlay.backgroundColor}
          fallback="#000000"
          disabled={overlay.backgroundType === 'none'}
          onChange={(backgroundColor) => onDraft({ backgroundColor })}
        />
      </Field>
      <Field id={id('x')} label={t('horizontal')}>
        <input
          id={id('x')}
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={overlay.anchorX}
          onChange={(e) => onDraft({ anchorX: snapAnchor(Number(e.target.value)) })}
          className="accent-primary"
        />
      </Field>
      <Field id={id('y')} label={t('vertical')}>
        <input
          id={id('y')}
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={overlay.anchorY}
          onChange={(e) => onDraft({ anchorY: snapAnchor(Number(e.target.value)) })}
          className="accent-primary"
        />
      </Field>
      <Field id={id('align')} label={t('alignment')}>
        <NativeSelect
          id={id('align')}
          value={overlay.alignment}
          onChange={(e) => onDraft({ alignment: e.target.value })}
        >
          {ALIGNMENTS.map((a) => (
            <option key={a} value={a}>
              {t(`alignments.${a}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id={id('italic')} label={t('style')}>
        <label className="flex h-8 items-center gap-2 text-sm">
          <input
            id={id('italic')}
            type="checkbox"
            checked={overlay.fontItalic}
            onChange={(e) => onDraft({ fontItalic: e.target.checked })}
          />
          {t('italic')}
        </label>
      </Field>
      <Field id={id('in')} label={t('animationIn')}>
        <NativeSelect
          id={id('in')}
          value={overlay.animationIn}
          onChange={(e) => onDraft({ animationIn: e.target.value })}
        >
          {ANIMATIONS.map((a) => (
            <option key={a} value={a}>
              {t(`animations.${a}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id={id('out')} label={t('animationOut')}>
        <NativeSelect
          id={id('out')}
          value={overlay.animationOut}
          onChange={(e) => onDraft({ animationOut: e.target.value })}
        >
          {ANIMATIONS.map((a) => (
            <option key={a} value={a}>
              {t(`animations.${a}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </fieldset>
  );
}
