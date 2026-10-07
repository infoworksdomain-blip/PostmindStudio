'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { MonitorPlay, ShieldCheck } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { NativeSelect } from '@/components/ui/native-select';
import { Field } from '../review/field';
import { VideoUploadField } from '../uploads/video-upload-field';
import { countWords, HOOK_LINE_MAX_CHARS, HOOK_LINE_MAX_WORDS, type HookDemoChoice } from './body';

// BACKLOG 22.1 — Create → "Hook + demo": the business's demo-video bank (pick one, or upload a
// new demo: a screen recording or phone-in-hand footage), an optional hook line (else Studio
// writes one, at most 12 words), how the hook is made (a generated reaction, or a licensed
// reaction clip from the library), the layout and how the demo's own sound sits with the music.
// A hook + demo video counts as one video; no cost is shown.

interface DemoVideo {
  id: string;
  fileName: string;
  durationSec: number | null;
}

const REACTIONS = ['surprised', 'curious', 'wait_what'] as const;
const LAYOUTS = ['sequential', 'stacked'] as const;
const MIXES = ['balanced', 'demo', 'music'] as const;

export function HookDemoOptions({
  businessId,
  value,
  onChange,
}: {
  businessId: string | null;
  value: HookDemoChoice;
  onChange: (next: HookDemoChoice) => void;
}) {
  const t = useTranslations('create.hookDemo');
  const f = useFormat();
  const demos = useApi<{ data: DemoVideo[] }>(businessId ? '/uploads/demo-videos' : null, {
    businessId,
  });
  const list = demos.data?.data ?? [];
  const set = (next: Partial<HookDemoChoice>) => onChange({ ...value, ...next });
  // The newest demo is chosen until the owner picks another (Fastlane uses the newest too).
  const newest = list[0]?.id;
  useEffect(() => {
    if (!value.demoUploadId && newest) onChange({ ...value, demoUploadId: newest });
  }, [newest, value, onChange]);
  const words = countWords(value.hookLine);

  return (
    <section
      aria-labelledby="create-hook-demo-title"
      className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4"
    >
      <div className="flex items-start gap-2">
        <MonitorPlay className="mt-0.5 size-5 shrink-0" strokeWidth={1.5} aria-hidden />
        <div>
          <h2 id="create-hook-demo-title" className="text-sm font-medium">
            {t('title')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('intro')}</p>
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">{t('demo')}</legend>
        {list.length === 0 && !demos.isLoading && (
          <p className="text-sm text-muted-foreground" data-testid="hook-demo-empty">
            {t('noDemo')}
          </p>
        )}
        {list.length > 0 && (
          <div role="radiogroup" aria-label={t('demo')} className="flex flex-col gap-1.5">
            {list.map((demo) => (
              <button
                key={demo.id}
                type="button"
                role="radio"
                aria-checked={value.demoUploadId === demo.id}
                onClick={() => set({ demoUploadId: demo.id })}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-start text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  value.demoUploadId === demo.id
                    ? 'border-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="truncate">{demo.fileName}</span>
                {demo.durationSec !== null && (
                  <span className="shrink-0 text-xs tabular-nums">
                    {f.duration(demo.durationSec)}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {businessId && (
          <VideoUploadField
            id="create-hook-demo-upload"
            label={list.length ? t('uploadAnother') : t('upload')}
            kind="demo_video"
            businessId={businessId}
            onUploaded={(result) => {
              set({ demoUploadId: result.upload.id });
              void demos.mutate();
            }}
          />
        )}
        <p className="text-xs text-muted-foreground">{t('demoHint')}</p>
      </fieldset>

      <Field id="create-hook-line" label={t('hookLine')}>
        <Input
          id="create-hook-line"
          value={value.hookLine}
          maxLength={HOOK_LINE_MAX_CHARS}
          placeholder={t('hookLinePlaceholder')}
          aria-describedby="create-hook-line-hint"
          onChange={(e) => set({ hookLine: e.target.value.replace(/[\r\n]+/g, ' ') })}
        />
      </Field>
      <p
        id="create-hook-line-hint"
        className={cn(
          '-mt-2 text-xs',
          words > HOOK_LINE_MAX_WORDS ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {t('hookLineHint', { count: words, max: HOOK_LINE_MAX_WORDS })}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="create-hook-source" label={t('hookSource')}>
          <NativeSelect
            id="create-hook-source"
            value={value.hookSource}
            onChange={(e) => set({ hookSource: e.target.value as HookDemoChoice['hookSource'] })}
          >
            <option value="ai_creator">{t('hookSources.ai_creator')}</option>
            <option value="library">{t('hookSources.library')}</option>
          </NativeSelect>
        </Field>
        <Field id="create-hook-reaction" label={t('reaction')}>
          <NativeSelect
            id="create-hook-reaction"
            value={value.reaction}
            disabled={value.hookSource !== 'ai_creator'}
            onChange={(e) => set({ reaction: e.target.value as HookDemoChoice['reaction'] })}
          >
            {REACTIONS.map((r) => (
              <option key={r} value={r}>
                {t(`reactions.${r}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="create-hook-layout" label={t('layout')}>
          <NativeSelect
            id="create-hook-layout"
            value={value.layout}
            onChange={(e) => set({ layout: e.target.value as HookDemoChoice['layout'] })}
          >
            {LAYOUTS.map((l) => (
              <option key={l} value={l}>
                {t(`layouts.${l}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="create-hook-mix" label={t('audioMix')}>
          <NativeSelect
            id="create-hook-mix"
            value={value.audioMix}
            onChange={(e) => set({ audioMix: e.target.value as HookDemoChoice['audioMix'] })}
          >
            {MIXES.map((m) => (
              <option key={m} value={m}>
                {t(`audioMixes.${m}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} aria-hidden />
        {t('disclosure')}
      </p>
    </section>
  );
}
