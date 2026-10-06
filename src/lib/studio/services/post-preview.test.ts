import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { AssetStorage } from '../storage';
import { getPostPreview, previewAspect } from './post-preview';
import { slideText } from './post-preview-media';

// 24.2 — the side panel's preview data, on an in-memory stand-in for the tables it reads.

const NOW = Date.parse('2026-10-06T10:00:00Z');

interface ProjectRow {
  id: string;
  organisationId: string;
  name: string | null;
  state: string;
  sourceType: string;
  metadata: unknown;
  targetFormats: unknown;
  publications: Array<{
    id: string;
    platform: string;
    state: string;
    scheduledFor: Date | null;
    publishedAt: Date | null;
    platformUrl: string | null;
    caption: string | null;
    hashtags: string[];
  }>;
}

function fake(
  project: ProjectRow,
  extra: {
    render?: Record<string, unknown> | null;
    slides?: unknown[];
    images?: unknown[];
    script?: unknown;
    assets?: unknown[];
  } = {},
) {
  const db = {
    videoProject: {
      findFirst: vi.fn(async (args: { where: { id: string; organisationId: string } }) =>
        args.where.id === project.id && args.where.organisationId === project.organisationId
          ? project
          : null,
      ),
      findMany: vi.fn(async (args: { where: { organisationId: string } }) =>
        args.where.organisationId === project.organisationId ? [project] : [],
      ),
    },
    videoRender: { findFirst: vi.fn(async () => extra.render ?? null) },
    slideshowSlide: { findMany: vi.fn(async () => extra.slides ?? []) },
    imageLibraryItem: { findMany: vi.fn(async () => extra.images ?? []) },
    videoScript: { findFirst: vi.fn(async () => extra.script ?? null) },
    videoAsset: { findMany: vi.fn(async () => extra.assets ?? []) },
  };
  const storage = {
    signedUrl: vi.fn(async (bucket: string, key: string) => `https://cdn.test/${bucket}/${key}`),
  };
  return {
    deps: {
      db: db as unknown as PrismaClient,
      storage: storage as unknown as AssetStorage,
      now: () => NOW,
    },
    db,
  };
}

function project(overrides: Partial<ProjectRow>): ProjectRow {
  return {
    id: 'p1',
    organisationId: 'org',
    name: 'Autumn menu',
    state: 'APPROVED',
    sourceType: 'BRIEF',
    metadata: {},
    targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 30 }],
    publications: [],
    ...overrides,
  };
}

describe('getPostPreview', () => {
  it('plays the finished render with the publication caption, networks and time', async () => {
    const at = new Date('2026-10-08T09:00:00Z');
    const { deps } = fake(
      project({
        publications: [
          {
            id: 'pub1',
            platform: 'instagram_reel',
            state: 'SCHEDULED',
            scheduledFor: at,
            publishedAt: null,
            platformUrl: null,
            caption: 'New autumn menu',
            hashtags: ['autumn', 'cafe'],
          },
        ],
      }),
      {
        render: {
          s3Bucket: 'renders',
          s3Key: 'p1/final.mp4',
          thumbnailS3Key: 'p1/thumb.jpg',
          durationSec: 21.5,
          aspectRatio: '9:16',
        },
      },
    );
    const preview = await getPostPreview(deps, 'org', 'p1');
    expect(preview.media).toEqual({
      kind: 'video',
      url: 'https://cdn.test/renders/p1/final.mp4',
      posterUrl: 'https://cdn.test/renders/p1/thumb.jpg',
      durationSec: 21.5,
    });
    expect(preview).toMatchObject({
      aspectRatio: '9:16',
      caption: 'New autumn menu',
      hashtags: ['autumn', 'cafe'],
      platforms: ['instagram_reel'],
      scheduledFor: at.toISOString(),
      format: 'ai_video',
    });
    expect(preview.live.stage).toBe('ready');
  });

  it("404s another organisation's project", async () => {
    const { deps } = fake(project({}));
    await expect(getPostPreview(deps, 'other', 'p1')).rejects.toMatchObject({ status: 404 });
  });

  it('shows a slideshow before its render as slides (text, picture, duration)', async () => {
    const { deps } = fake(
      project({
        sourceType: 'SLIDESHOW',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '4:5' }],
      }),
      {
        slides: [
          { imageAssetId: 'img1', durationSec: 2.5, metadata: { text: 'Hook' } },
          {
            imageAssetId: null,
            durationSec: 3,
            metadata: { quote: 'Best coffee', caption: 'Ann' },
          },
        ],
        images: [{ id: 'img1', s3Bucket: 'library', s3Key: 'a.jpg' }],
      },
    );
    const preview = await getPostPreview(deps, 'org', 'p1');
    expect(preview.aspectRatio).toBe('4:5');
    expect(preview.media).toEqual({
      kind: 'slides',
      rendered: false,
      slides: [
        { imageUrl: 'https://cdn.test/library/a.jpg', text: 'Hook', durationSec: 2.5 },
        { imageUrl: null, text: 'Best coffee\nAnn', durationSec: 3 },
      ],
    });
  });

  it('shows the wall-of-text block for its reading time', async () => {
    const { deps } = fake(
      project({
        sourceType: 'WALL_OF_TEXT',
        metadata: {
          wallOfText: {
            text: null,
            writtenText: 'Three things',
            background: 'calm',
            durationSec: 8,
          },
        },
      }),
    );
    const preview = await getPostPreview(deps, 'org', 'p1');
    expect(preview.media).toEqual({ kind: 'text', text: 'Three things', durationSec: 8 });
  });

  it('shows the storyboard of a video still being made, with stills where they exist', async () => {
    const { deps } = fake(
      project({
        state: 'ASSETS_GENERATING',
        metadata: { ugc: {}, postCopy: { tiktok: { caption: 'Owner caption', hashtags: ['x'] } } },
      }),
      {
        script: {
          shots: [
            {
              id: 's1',
              sortOrder: 0,
              durationSec: 3,
              onScreenText: 'Wait for it',
              voiceoverText: null,
              sceneDescription: 'Cafe front',
              state: 'SUCCEEDED',
              assetId: 'a1',
            },
            {
              id: 's2',
              sortOrder: 1,
              durationSec: 4,
              onScreenText: null,
              voiceoverText: null,
              sceneDescription: 'Latte art close-up',
              state: 'GENERATING',
              assetId: null,
            },
          ],
        },
        assets: [{ id: 'a1', s3Bucket: 'assets', s3Key: 's1.png' }],
      },
    );
    const preview = await getPostPreview(deps, 'org', 'p1');
    expect(preview.format).toBe('ugc');
    expect(preview.caption).toBe('Owner caption');
    expect(preview.platforms).toEqual(['tiktok']);
    expect(preview.live.stage).toBe('making_clips');
    expect(preview.media).toEqual({
      kind: 'storyboard',
      shots: [
        {
          id: 's1',
          sortOrder: 0,
          durationSec: 3,
          text: 'Wait for it',
          stillUrl: 'https://cdn.test/assets/s1.png',
          state: 'SUCCEEDED',
        },
        {
          id: 's2',
          sortOrder: 1,
          durationSec: 4,
          text: 'Latte art close-up',
          stillUrl: null,
          state: 'GENERATING',
        },
      ],
    });
  });

  it('has nothing to preview for an empty project', async () => {
    const { deps } = fake(project({ state: 'DRAFT', targetFormats: [] }));
    const preview = await getPostPreview(deps, 'org', 'p1');
    expect(preview.media).toEqual({ kind: 'none' });
    expect(preview.caption).toBeNull();
    expect(preview.aspectRatio).toBe('9:16');
  });
});

describe('preview helpers', () => {
  it('picks the first known aspect ratio, else portrait', () => {
    expect(previewAspect(null, '16:9')).toBe('16:9');
    expect(previewAspect('2:3', undefined)).toBe('9:16');
  });

  it("reads a slide's words whatever its type", () => {
    expect(slideText({ value: '93%', label: 'come back' })).toBe('93% come back');
    expect(slideText({ name: 'Flat white' })).toBe('Flat white');
    expect(slideText({})).toBeNull();
  });
});
