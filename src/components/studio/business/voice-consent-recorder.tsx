'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Mic, Square, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAudioFileProblem, useFormatBytes } from './voice-types';

// Spec 10.2 — the consent recording: the speaker reading the consent statement aloud. Recorded
// in the browser with MediaRecorder when it is available, otherwise (or by choice) uploaded.

function canRecord(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

function recordingFile(chunks: Blob[], mimeType: string): File {
  const type = mimeType.split(';')[0] || 'audio/webm';
  const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
  return new File(chunks, `consent-recording.${ext}`, { type });
}

export function ConsentRecorder({
  value,
  onChange,
}: {
  value: File | null;
  onChange: (file: File | null) => void;
}) {
  const t = useTranslations('business.voice.recorder');
  const audioFileProblem = useAudioFileProblem();
  const formatBytes = useFormatBytes();
  const [recordable, setRecordable] = useState(false);
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);

  useEffect(() => setRecordable(canRecord()), []);

  useEffect(() => {
    if (!value || typeof URL.createObjectURL !== 'function') {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(value);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [value]);

  useEffect(() => () => recorder.current?.stream.getTracks().forEach((t) => t.stop()), []);

  async function start() {
    setProblem(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        onChange(recordingFile(chunks, rec.mimeType));
        setRecording(false);
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setProblem(t('micFailed'));
    }
  }

  function pick(file: File | undefined) {
    if (!file) return;
    const issue = audioFileProblem(file);
    setProblem(issue);
    onChange(issue ? null : file);
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {recordable &&
          (recording ? (
            <Button type="button" variant="destructive" onClick={() => recorder.current?.stop()}>
              <Square /> {t('stop')}
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={() => void start()}>
              <Mic /> {value ? t('recordAgain') : t('recordNow')}
            </Button>
          ))}
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted focus-within:ring-2 focus-within:ring-ring">
          <Upload className="size-4" aria-hidden />
          {t('upload')}
          <Input
            type="file"
            accept="audio/*"
            className="sr-only"
            aria-label={t('fileAria')}
            onChange={(e) => {
              pick(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {recording && (
        <p className="flex items-center gap-2 text-xs text-primary" role="status">
          <span aria-hidden className="size-2 animate-rec rounded-full bg-primary" />
          {t('recording')}
        </p>
      )}
      {value && !recording && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{t('fileMeta', { name: value.name, size: formatBytes(value.size) })}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('removeAria')}
            onClick={() => onChange(null)}
          >
            <X />
          </Button>
          {previewUrl && (
            <audio controls src={previewUrl} className="h-8 w-full max-w-xs">
              <track kind="captions" />
            </audio>
          )}
        </div>
      )}
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
