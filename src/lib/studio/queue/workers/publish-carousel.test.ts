import { describe, expect, it, vi } from 'vitest';
import type { PipelineDeps } from '../../pipeline/deps';
import { publishVideo } from './publish-video';

// 21.6: the publish worker sends a carousel render's slides through the platform's
// publishCarousel, with the AI label only when a picture was AI-generated.

const composition = {
  kind: 'carousel',
  version: 1,
  bucket: 'renders',
  theme: 'light',
  language: 'en-GB',
  aiGenerated: false,
  slides: [1, 0].map((index) => ({
    index,
    pngKey: `s${index}.png`,
    jpegKey: `s${index}.jpg`,
    width: 1080,
    height: 1350,
    altText: `Slide ${index}`,
    postIds: ['p'],
  })),
  issues: [],
};

function makeDeps(platform: string, publisher: Record<string, unknown>) {
  const update = vi.fn(async () => ({}));
  const db = {
    videoPublication: {
      findFirst: vi.fn(async () => ({
        id: 'pub_1',
        organisationId: 'org_1',
        projectId: 'prj_1',
        platform,
        platformAccountId: 'acct',
        state: 'SCHEDULED',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        scheduledFor: null,
        caption: 'Tips\n\n#bread',
        hashtags: ['bread'],
        metadata: { rawCaption: 'Tips', connectionId: 'conn_1' },
        render: { id: 'r1', s3Bucket: 'renders', s3Key: 's0.png', composition },
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update,
      findMany: vi.fn(async () => [{ state: 'PUBLISHED' }]),
    },
    videoProject: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const deps = {
    db,
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    now: () => 0,
    killSwitch: { assertNotKilled: vi.fn() },
    audit: vi.fn(),
    queue: { add: vi.fn() },
    publishing: {
      db,
      meta: { getCredentials: vi.fn(async () => ({ accessToken: 'tok', accountId: 'ig_1' })) },
      publishers: { [platform]: publisher },
      storage: {
        size: vi.fn(async () => 10),
        signedUrl: vi.fn(async (_b: string, key: string) => `https://cdn/${key}`),
        readRange: vi.fn(async () => new Uint8Array([1])),
      },
      engagement: { attributePublication: vi.fn() },
      logger: { warn: vi.fn() },
      now: () => 0,
    },
  } as unknown as PipelineDeps;
  return { deps, update };
}

const data = {
  publicationId: 'pub_1',
  projectId: 'prj_1',
  organisationId: 'org_1',
  runId: 'r',
  planTier: 'BASIC' as const,
};

describe('publishVideo with a carousel render', () => {
  it('publishes the slides in order as a carousel', async () => {
    const publishCarousel = vi.fn(async () => ({
      platformPostId: 'm1',
      platformUrl: 'https://instagram.com/p/m1',
      metadata: {},
    }));
    const publish = vi.fn();
    const { deps, update } = makeDeps('instagram_feed', { publish, publishCarousel });
    await publishVideo(data, deps);
    expect(publish).not.toHaveBeenCalled();
    const request = (publishCarousel.mock.calls[0] as unknown[] | undefined)?.[0] as {
      slides: Array<{ jpegUrl: string; altText: string }>;
      aiGenerated: boolean;
      text: string;
      accessToken: string;
    };
    expect(request.slides.map((s) => s.jpegUrl)).toEqual([
      'https://cdn/s0.jpg',
      'https://cdn/s1.jpg',
    ]);
    expect(request).toMatchObject({
      aiGenerated: false,
      text: 'Tips\n\n#bread',
      accessToken: 'tok',
    });
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'PUBLISHED', platformPostId: 'm1' }),
      }),
    );
  });

  it('fails without retrying where the platform takes no carousels', async () => {
    const { deps } = makeDeps('youtube', { publish: vi.fn() });
    await expect(publishVideo(data, deps)).rejects.toMatchObject({
      errorClass: 'invalid_request',
      retryable: false,
    });
  });
});
