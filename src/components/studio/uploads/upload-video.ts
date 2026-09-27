import { api, ApiError, newIdempotencyKey } from '@/lib/client/api';

// Phase 13.5 — browser side of an upload: ask Studio for a presigned PUT (POST /uploads), PUT the
// file straight to storage with the headers Studio returned (Content-Type is signed), then ask
// Studio to check and probe it (POST /uploads/:id/complete). The file never passes through
// Studio's servers.

export type UploadKind = 'source_video' | 'slide_clip';

export const UPLOAD_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;
export const UPLOAD_MAX_BYTES: Record<UploadKind, number> = {
  source_video: 500 * 1024 * 1024,
  slide_clip: 200 * 1024 * 1024,
};

export interface UploadResult {
  upload: {
    id: string;
    state: string;
    fileName: string;
    durationSec: number | null;
    width: number | null;
    height: number | null;
  };
  asset: {
    id: string;
    durationSec: number | null;
    width: number | null;
    height: number | null;
  } | null;
}

/** Why a file cannot be uploaded, or null. Checked before any request is made. */
export function uploadProblem(
  file: { type: string; size: number },
  kind: UploadKind,
): string | null {
  if (!(UPLOAD_TYPES as readonly string[]).includes(file.type))
    return 'Choose an MP4, MOV or WebM video.';
  if (file.size <= 0) return 'The file is empty.';
  if (file.size > UPLOAD_MAX_BYTES[kind])
    return `Videos can be at most ${Math.round(UPLOAD_MAX_BYTES[kind] / 1024 / 1024)} MB.`;
  return null;
}

export async function uploadVideo(
  file: File,
  target: { kind: UploadKind; businessId?: string; projectId?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<UploadResult> {
  const problem = uploadProblem(file, target.kind);
  if (problem) throw new ApiError(400, 'validation_error', problem);
  const { upload } = await api<{
    upload: { id: string; putUrl: string; headers: Record<string, string> };
  }>('/uploads', {
    method: 'POST',
    body: {
      kind: target.kind,
      contentType: file.type,
      sizeBytes: file.size,
      fileName: file.name.slice(0, 200) || 'video',
      ...(target.businessId && { businessId: target.businessId }),
      ...(target.projectId && { projectId: target.projectId }),
    },
    idempotencyKey: newIdempotencyKey(),
  });
  const put = await fetchImpl(upload.putUrl, {
    method: 'PUT',
    headers: upload.headers,
    body: file,
  });
  if (!put.ok) throw new ApiError(put.status, 'upload_failed', 'The upload to storage failed.');
  return api<UploadResult>(`/uploads/${upload.id}/complete`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey(),
  });
}
