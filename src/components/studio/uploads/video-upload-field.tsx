'use client';

import { useState, type ChangeEvent } from 'react';
import { CheckCircle2, Loader2, Upload } from 'lucide-react';
import { errorMessage } from '@/lib/client/api';
import { formatDuration } from '@/lib/client/format';
import { uploadVideo, UPLOAD_TYPES, type UploadKind, type UploadResult } from './upload-video';

// A file picker that uploads the chosen video at once (13.5) and reports the result: used by
// Create ("Upload a video") and the slide editor (VIDEO_CLIP slides).

export function VideoUploadField({
  id,
  label,
  kind,
  businessId,
  projectId,
  disabled,
  onUploaded,
}: {
  id: string;
  label: string;
  kind: UploadKind;
  businessId?: string;
  projectId?: string;
  disabled?: boolean;
  onUploaded: (result: UploadResult) => void;
}) {
  const [status, setStatus] = useState<
    | { state: 'idle' }
    | { state: 'uploading'; name: string }
    | { state: 'done'; result: UploadResult }
    | { state: 'error'; message: string }
  >({ state: 'idle' });

  async function choose(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setStatus({ state: 'uploading', name: file.name });
    try {
      const result = await uploadVideo(file, { kind, businessId, projectId });
      setStatus({ state: 'done', result });
      onUploaded(result);
    } catch (err) {
      setStatus({ state: 'error', message: errorMessage(err) });
    }
  }

  const busy = status.state === 'uploading';
  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={id}
        className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm transition-colors hover:border-foreground focus-within:ring-2 focus-within:ring-ring"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
        {label}
        <input
          id={id}
          type="file"
          accept={UPLOAD_TYPES.join(',')}
          disabled={disabled || busy}
          onChange={(e) => void choose(e)}
          className="sr-only"
        />
      </label>
      <p aria-live="polite" className="text-xs text-muted-foreground">
        {status.state === 'uploading' && `Uploading ${status.name}…`}
        {status.state === 'done' && (
          <span className="inline-flex items-center gap-1 text-foreground">
            <CheckCircle2 className="size-3.5 text-emerald-600" /> {status.result.upload.fileName}
            {status.result.upload.durationSec !== null &&
              ` · ${formatDuration(status.result.upload.durationSec)}`}
            {status.result.upload.width && status.result.upload.height
              ? ` · ${status.result.upload.width}×${status.result.upload.height}`
              : ''}
          </span>
        )}
        {status.state === 'error' && <span className="text-destructive">{status.message}</span>}
        {status.state === 'idle' && 'MP4, MOV or WebM.'}
      </p>
    </div>
  );
}
