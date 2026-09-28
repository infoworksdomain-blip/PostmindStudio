'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Loader2, PencilLine, Save, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import type { ProjectDetail, Script } from '@/lib/client/types';
import { ErrorState } from '../primitives';
import { SHOT_EDITABLE } from './types';
import { useAction } from './use-action';

// The written script per target format, set as a readable manuscript (spec 14.2). 13.1: each
// script can be edited (PATCH /scripts/:id — changed narration re-voices only those shots; other
// edits mark the variants out of date) or rewritten from the brief with an optional instruction
// (POST /scripts/:id/regenerate).

interface ShotText {
  voiceoverText: string;
  onScreenText: string;
}

export interface ScriptEdit {
  fullText?: string;
  shots?: Array<{ id: string; voiceoverText?: string | null; onScreenText?: string | null }>;
}

/** The PATCH /scripts/:id body: only what changed (null clears a field). */
export function scriptPatch(
  script: Pick<Script, 'fullText' | 'shots'>,
  fullText: string,
  texts: Record<string, ShotText>,
): ScriptEdit | null {
  const patch: ScriptEdit = {};
  if (fullText.trim() && fullText.trim() !== script.fullText) patch.fullText = fullText.trim();
  const shots = script.shots.flatMap((shot) => {
    const edit = texts[shot.id];
    if (!edit) return [];
    const change: { id: string; voiceoverText?: string | null; onScreenText?: string | null } = {
      id: shot.id,
    };
    if (edit.voiceoverText.trim() !== (shot.voiceoverText ?? ''))
      change.voiceoverText = edit.voiceoverText.trim() || null;
    if (edit.onScreenText.trim() !== (shot.onScreenText ?? ''))
      change.onScreenText = edit.onScreenText.trim() || null;
    return Object.keys(change).length > 1 ? [change] : [];
  });
  if (shots.length) patch.shots = shots;
  return Object.keys(patch).length ? patch : null;
}

function ScriptEditor({
  scriptId,
  onDone,
  onChanged,
}: {
  scriptId: string;
  onDone: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations('review.script.editor');
  const f = useFormat();
  const { data, error, isLoading, mutate } = useApi<{ script: Script }>(`/scripts/${scriptId}`);
  const { pending, run, busy } = useAction();
  const [fullText, setFullText] = useState('');
  const [texts, setTexts] = useState<Record<string, ShotText>>({});
  const script = data?.script;

  useEffect(() => {
    if (!script) return;
    setFullText(script.fullText);
    setTexts(
      Object.fromEntries(
        script.shots.map((s) => [
          s.id,
          { voiceoverText: s.voiceoverText ?? '', onScreenText: s.onScreenText ?? '' },
        ]),
      ),
    );
  }, [script]);

  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (isLoading || !script)
    return <Skeleton className="h-48 rounded-xl" aria-label={t('loading')} />;
  const patch = scriptPatch(script, fullText, texts);
  const revoices =
    patch?.shots?.filter((s) => s.voiceoverText !== undefined).map((s) => s.id).length ?? 0;

  async function save() {
    if (!patch) return;
    const ok = await run('save', `/scripts/${scriptId}`, {
      method: 'PATCH',
      body: patch,
      success: revoices ? t('savedRevoice', { count: revoices }) : t('savedRerender'),
    });
    if (ok) {
      await mutate();
      onChanged();
      onDone();
    }
  }

  const set = (id: string, change: Partial<ShotText>) =>
    setTexts((t) => ({ ...t, [id]: { ...(t[id] as ShotText), ...change } }));

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
      <label htmlFor={`full-${scriptId}`} className="text-xs font-medium text-muted-foreground">
        {t('voiceover')}
      </label>
      <Textarea
        id={`full-${scriptId}`}
        value={fullText}
        maxLength={20_000}
        rows={4}
        onChange={(e) => setFullText(e.target.value)}
      />
      <ol className="flex flex-col gap-3">
        {script.shots.map((shot, i) => (
          <li key={shot.id} className="grid gap-2 border-t border-border pt-3 sm:grid-cols-2">
            <p className="text-xs tracking-[0.14em] text-muted-foreground uppercase sm:col-span-2">
              {t('shot', { n: i + 1, duration: f.duration(shot.durationSec) })}
            </p>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('narration')}
              <Textarea
                aria-label={t('narrationAria', { n: i + 1 })}
                value={texts[shot.id]?.voiceoverText ?? ''}
                maxLength={2_000}
                rows={2}
                onChange={(e) => set(shot.id, { voiceoverText: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('onScreen')}
              <Input
                aria-label={t('onScreenAria', { n: i + 1 })}
                value={texts[shot.id]?.onScreenText ?? ''}
                maxLength={300}
                onChange={(e) => set(shot.id, { onScreenText: e.target.value })}
              />
            </label>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">
        {revoices ? t('revoiceNote', { count: revoices }) : t('textNote')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={!patch || busy}>
          {pending === 'save' ? <Loader2 className="animate-spin" /> : <Save />} {t('save')}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          <X /> {t('cancel')}
        </Button>
      </div>
    </div>
  );
}

function RegenerateScript({
  scriptId,
  disabled,
  onChanged,
}: {
  scriptId: string;
  disabled: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations('review.script.regenerate');
  const [instruction, setInstruction] = useState('');
  const { pending, run } = useAction();

  async function regenerate() {
    const ok = await run('regenerate', `/scripts/${scriptId}/regenerate`, {
      body: instruction.trim() ? { instruction: instruction.trim() } : {},
      success: t('started'),
    });
    if (ok) {
      setInstruction('');
      onChanged();
    }
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
        {t('instruction')}
        <Input
          value={instruction}
          maxLength={1_000}
          disabled={disabled}
          placeholder={t('placeholder')}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </label>
      <Button variant="outline" onClick={regenerate} disabled={disabled || pending !== null}>
        {pending ? <Loader2 className="animate-spin" /> : <Sparkles />} {t('button')}
      </Button>
    </div>
  );
}

export function ScriptView({
  project,
  onChanged = () => undefined,
}: {
  project: ProjectDetail;
  onChanged?: () => void;
}) {
  const t = useTranslations('review.script');
  const f = useFormat();
  const { brief, scripts } = project;
  const [editing, setEditing] = useState<string | null>(null);
  const editable = SHOT_EDITABLE.has(project.state);
  const rewritable =
    editable && Boolean(brief) && !['SLIDESHOW', 'UPLOAD'].includes(project.sourceType);
  return (
    <div className="flex flex-col gap-8">
      {brief && (
        <dl className="grid gap-4 border-s-2 border-primary/60 ps-4 sm:grid-cols-2">
          {(
            [
              ['hook', brief.hook],
              ['keyMessage', brief.keyMessage],
              ['audience', brief.targetAudience],
              ['tone', brief.tone],
            ] as const
          ).map(([term, value]) => (
            <div key={term}>
              <dt className="text-xs tracking-[0.14em] text-muted-foreground uppercase">
                {t(`brief.${term}`)}
              </dt>
              <dd className="mt-1 text-sm">{value || t('empty')}</dd>
            </div>
          ))}
        </dl>
      )}
      {scripts.length === 0 && <p className="text-sm text-muted-foreground">{t('notWritten')}</p>}
      {scripts.map((script) => (
        <article
          key={script.id}
          aria-label={t('aria', { platform: f.platform(script.targetPlatform) })}
        >
          <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="font-display text-2xl">{f.platform(script.targetPlatform)}</h3>
            <p className="tabular text-xs text-muted-foreground">
              {script.targetAspectRatio} · {f.duration(script.targetDurationSec)} ·{' '}
              {t('shots', { count: script.shots.length })}
            </p>
            {editable && editing !== script.id && project.sourceType !== 'SLIDESHOW' && (
              <Button
                variant="ghost"
                size="sm"
                className="ms-auto"
                onClick={() => setEditing(script.id)}
              >
                <PencilLine /> {t('edit')}
              </Button>
            )}
          </header>
          {editing === script.id ? (
            <ScriptEditor
              scriptId={script.id}
              onDone={() => setEditing(null)}
              onChanged={onChanged}
            />
          ) : (
            <p className="max-w-prose font-display text-lg leading-relaxed whitespace-pre-wrap">
              {script.fullText}
            </p>
          )}
          {rewritable && editing !== script.id && (
            <div className="mt-4">
              <RegenerateScript scriptId={script.id} disabled={false} onChanged={onChanged} />
            </div>
          )}
        </article>
      ))}
      {!editable && scripts.length > 0 && (
        <p className="text-xs text-muted-foreground">{t('notEditable')}</p>
      )}
    </div>
  );
}
