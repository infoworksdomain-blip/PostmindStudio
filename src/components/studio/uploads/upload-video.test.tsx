// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCreateBody, validateCreate, type CreateState } from '../create/body';
import { mockFetch, renderWithSWR } from '../review/test-helpers';
import { uploadProblem, uploadProblemText, uploadVideo } from './upload-video';
import { VideoUploadField } from './video-upload-field';

// 13.5 — browser uploads: presigned PUT, then /complete; Create's "Upload a video" body.

afterEach(() => vi.unstubAllGlobals());

const created = {
  ok: true,
  upload: {
    id: 'upl_1',
    putUrl: 'https://s3.test/orgs/o/uploads/upl_1/source.mp4?sig',
    headers: { 'content-type': 'video/mp4' },
  },
};
const completed = {
  ok: true,
  upload: {
    id: 'upl_1',
    state: 'READY',
    fileName: 'shop-tour.mp4',
    durationSec: 41.2,
    width: 1080,
    height: 1920,
  },
  asset: null,
};

function uploadRoutes() {
  return mockFetch([
    { method: 'POST', match: '/uploads', status: 201, body: created },
    { method: 'PUT', match: /s3\.test/, body: {} },
    { method: 'POST', match: '/uploads/upl_1/complete', body: completed },
  ]);
}

describe('uploadProblem', () => {
  it('checks type and size before anything is sent', () => {
    expect(uploadProblem({ type: 'video/mp4', size: 10 }, 'source_video')).toBeNull();
    expect(uploadProblem({ type: 'image/png', size: 10 }, 'source_video')).toEqual({
      code: 'type',
    });
    expect(uploadProblem({ type: 'video/mp4', size: 0 }, 'slide_clip')).toEqual({ code: 'empty' });
    const tooLarge = uploadProblem({ type: 'video/mp4', size: 600 * 1024 * 1024 }, 'source_video');
    expect(tooLarge).toEqual({ code: 'tooLarge', maxMb: 500 });
    expect(uploadProblemText(tooLarge ?? { code: 'empty' })).toMatch(/500 MB/);
  });
});

describe('uploadVideo', () => {
  it('asks for a presigned URL, PUTs the file with the signed headers, then completes', async () => {
    const api = uploadRoutes();
    const file = new File([new Uint8Array(20)], 'shop-tour.mp4', { type: 'video/mp4' });
    const result = await uploadVideo(file, { kind: 'source_video', businessId: 'biz_1' });
    expect(result.upload.state).toBe('READY');
    expect(api.find('POST', '/uploads')[0]?.body).toEqual({
      kind: 'source_video',
      contentType: 'video/mp4',
      sizeBytes: 20,
      fileName: 'shop-tour.mp4',
      businessId: 'biz_1',
    });
    const put = api.calls.find((c) => c.method === 'PUT');
    expect(put?.headers).toEqual({ 'content-type': 'video/mp4' });
    expect(api.find('POST', '/uploads/upl_1/complete')).toHaveLength(1);
  });

  it('fails when storage refuses the PUT', async () => {
    mockFetch([
      { method: 'POST', match: '/uploads', status: 201, body: created },
      { method: 'PUT', match: /s3\.test/, status: 403, body: {} },
    ]);
    const file = new File([new Uint8Array(5)], 'a.mp4', { type: 'video/mp4' });
    await expect(uploadVideo(file, { kind: 'source_video' })).rejects.toThrow(/storage failed/);
  });
});

describe('VideoUploadField', () => {
  it('uploads the chosen file and reports its length and size', async () => {
    uploadRoutes();
    const onUploaded = vi.fn();
    renderWithSWR(
      <VideoUploadField
        id="up"
        label="Choose a video"
        kind="source_video"
        businessId="biz_1"
        onUploaded={onUploaded}
      />,
    );
    const file = new File([new Uint8Array(20)], 'shop-tour.mp4', { type: 'video/mp4' });
    await userEvent.upload(screen.getByLabelText('Choose a video'), file);
    await waitFor(() => expect(onUploaded).toHaveBeenCalled());
    const status = screen.getByText(/shop-tour\.mp4/).closest('p');
    expect(status).toHaveTextContent('shop-tour.mp4 · 41s · 1080×1920');
  });

  it('shows why a file was refused', async () => {
    mockFetch([]);
    renderWithSWR(
      <VideoUploadField id="up" label="Choose a video" kind="slide_clip" onUploaded={vi.fn()} />,
    );
    const file = new File([new Uint8Array(3)], 'x.gif', { type: 'image/gif' });
    await userEvent.upload(screen.getByLabelText('Choose a video'), file, { applyAccept: false });
    expect(await screen.findByText(/MP4, MOV or WebM video/)).toBeInTheDocument();
  });
});

describe('Create body for "Upload a video"', () => {
  const state: CreateState = {
    brief: '',
    source: 'UPLOAD',
    platforms: ['tiktok', 'youtube_short'],
    length: 'short',
    brandKitId: null,
    templateId: null,
    targetAudience: '',
    callToAction: '',
    budgetPounds: '',
    reviewPolicy: '',
    projectTemplate: null,
    autoPublish: false,
    autoPublishAccounts: {},
    upload: null,
  };

  it('needs a finished upload but no brief', () => {
    expect(validateCreate(state, 'biz_1')).toEqual(['uploadRequired']);
    expect(
      validateCreate({ ...state, upload: { id: 'upl_1', fileName: 'a.mp4' } }, 'biz_1'),
    ).toEqual([]);
  });

  it('sends sourceType UPLOAD with the uploadId and names it from the file', () => {
    const body = buildCreateBody(
      { ...state, upload: { id: 'upl_1', fileName: 'shop-tour.mp4' } },
      'biz_1',
      null,
    );
    expect(body).toMatchObject({ sourceType: 'UPLOAD', uploadId: 'upl_1', businessId: 'biz_1' });
    expect(body.brief).toBeUndefined();
    expect(body.name?.toLowerCase()).toContain('shop-tour');
    expect(body.targetFormats?.map((f) => f.platform)).toEqual(['tiktok', 'youtube_short']);
  });
});
