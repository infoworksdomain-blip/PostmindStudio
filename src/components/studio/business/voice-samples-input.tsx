'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MAX_VOICE_SAMPLES, useAudioFileProblem, useFormatBytes } from './voice-types';

// 1–5 voice samples for cloning; each is checked client-side (audio, ≤ 10 MB) before upload.

export function VoiceSamplesInput({
  value,
  onChange,
}: {
  value: File[];
  onChange: (files: File[]) => void;
}) {
  const t = useTranslations('business.voice.samples');
  const audioFileProblem = useAudioFileProblem();
  const formatBytes = useFormatBytes();
  const [problem, setProblem] = useState<string | null>(null);
  const totalBytes = value.reduce((sum, f) => sum + f.size, 0);

  function add(files: File[]) {
    const bad = files.map(audioFileProblem).find(Boolean) ?? null;
    const good = files.filter((f) => !audioFileProblem(f));
    const room = MAX_VOICE_SAMPLES - value.length;
    setProblem(bad ?? (good.length > room ? t('tooMany', { max: MAX_VOICE_SAMPLES }) : null));
    onChange([...value, ...good.slice(0, room)]);
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor="voice-samples">{t('label')}</Label>
      <Input
        id="voice-samples"
        type="file"
        accept="audio/*"
        multiple
        disabled={value.length >= MAX_VOICE_SAMPLES}
        onChange={(e) => {
          add(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      {value.length > 0 && (
        <ul className="grid gap-1 text-xs" aria-label={t('listAria')}>
          {value.map((file, i) => (
            <li key={`${file.name}-${i}`} className="flex items-center justify-between gap-2">
              <span className="truncate">
                {file.name} · {formatBytes(file.size)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('removeAria', { name: file.name })}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                <X />
              </Button>
            </li>
          ))}
          <li className="text-muted-foreground">
            {t('total', {
              count: value.length,
              max: MAX_VOICE_SAMPLES,
              size: formatBytes(totalBytes),
            })}
          </li>
        </ul>
      )}
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
