import { describe, expect, it } from 'vitest';
import type { PlatformConnection, ProjectDetail } from '@/lib/client/types';
import {
  addPost,
  draftFromView,
  editBody,
  hasList,
  movePost,
  removePost,
  roleOf,
  slidesOfPost,
} from './model';
import type { CarouselView } from './model';
import { carouselNetworks, latestCarouselRender } from './publish-model';

const account = (platform: PlatformConnection['platform'], id = platform): PlatformConnection =>
  ({
    id,
    platform,
    platformAccountName: id,
    state: 'active',
    businessId: 'biz_1',
  }) as PlatformConnection;

describe('carouselNetworks', () => {
  it('lists every network with its account or the reason it cannot take the carousel', () => {
    const networks = carouselNetworks([account('instagram'), account('linkedin')], 4);
    expect(networks.map((n) => [n.network, n.status, n.platform])).toEqual([
      ['instagram', 'ready', 'instagram_feed'],
      ['facebook', 'not_connected', 'facebook_feed'],
      ['linkedin', 'ready', 'linkedin_video'],
      ['tiktok', 'not_connected', 'tiktok'],
      ['youtube', 'youtube_video_only', ''],
      ['x', 'x_not_built', ''],
    ]);
  });

  it('applies the platform limits to the number of slides', () => {
    const byNetwork = (count: number) =>
      Object.fromEntries(
        carouselNetworks([account('instagram'), account('linkedin'), account('tiktok')], count).map(
          (n) => [n.network, n],
        ),
      );
    expect(byNetwork(11).instagram).toMatchObject({ status: 'too_many_slides', maxItems: 10 });
    expect(byNetwork(11).linkedin?.status).toBe('ready');
    expect(byNetwork(1).linkedin).toMatchObject({ status: 'too_few_slides', maxItems: 2 });
    expect(byNetwork(1).tiktok?.status).toBe('ready');
  });
});

describe('latestCarouselRender', () => {
  it('finds the newest publishable carousel render and its slide count', () => {
    const project = {
      renders: [
        { id: 'r2', targetPlatform: 'carousel', qualityCheckState: 'FAILED', composition: null },
        {
          id: 'r1',
          targetPlatform: 'carousel',
          qualityCheckState: 'PASSED',
          composition: {
            kind: 'carousel',
            version: 1,
            bucket: 'b',
            theme: 'light',
            language: 'en-GB',
            aiGenerated: true,
            slides: [
              {
                index: 0,
                pngKey: 'a',
                jpegKey: 'b',
                width: 1,
                height: 1,
                altText: '',
                postIds: [],
              },
            ],
            issues: [],
          },
        },
      ],
    } as unknown as ProjectDetail;
    expect(latestCarouselRender(project)).toEqual({ id: 'r1', slideCount: 1, aiGenerated: true });
    expect(latestCarouselRender({ renders: [] } as unknown as ProjectDetail)).toBeNull();
  });
});

describe('editor model', () => {
  const view = {
    carousel: {
      theme: 'light',
      profile: { displayName: 'Acme', handle: 'acme', logoUploadId: null },
      posts: [
        { id: 'a', text: 'A', image: { imageId: 'i', width: 1, height: 1, aiGenerated: false } },
        { id: 'b', text: 'B', image: null },
      ],
    },
  } as unknown as CarouselView;

  it('round-trips the view into an edit body', () => {
    expect(editBody(draftFromView(view))).toEqual({
      theme: 'light',
      profile: { displayName: 'Acme', handle: 'acme' },
      posts: [
        { id: 'a', text: 'A', imageId: 'i' },
        { id: 'b', text: 'B', imageId: null },
      ],
    });
  });

  it('moves, adds before the CTA and removes posts within the limits', () => {
    const draft = draftFromView(view);
    expect(movePost(draft, 'b', -1).posts.map((p) => p.id)).toEqual(['b', 'a']);
    expect(movePost(draft, 'a', -1)).toBe(draft);
    expect(addPost(draft, 'new').posts.map((p) => p.id)).toEqual(['a', 'new', 'b']);
    expect(removePost(removePost(draft, 'a'), 'b').posts.map((p) => p.id)).toEqual(['b']);
  });

  it('names roles, slides and lists', () => {
    expect([roleOf(0, 3), roleOf(1, 3), roleOf(2, 3), roleOf(0, 1)]).toEqual([
      'hook',
      'body',
      'cta',
      'hook',
    ]);
    expect(
      slidesOfPost(
        [
          { index: 0, postIds: ['a'] },
          { index: 1, postIds: ['a', 'b'] },
        ],
        'a',
      ),
    ).toEqual([1, 2]);
    expect(hasList('Intro\n→ a\n→ b')).toBe(true);
    expect(hasList('→ only one')).toBe(false);
  });
});
