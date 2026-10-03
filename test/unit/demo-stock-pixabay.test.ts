// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import '../../demo/api/handlers/index';
import { handle } from '../../demo/api/registry';

// 20.16 — live sources stock images from Pixabay only (Unsplash not approved, Pexels and
// Storyblocks not configured); the demo's sample library says the same.

describe('demo: stock images are attributed to Pixabay only', { timeout: 30_000 }, () => {
  it('every stock image names Pixabay, its licence and its Pixabay page', async () => {
    const res = await handle(
      new URL(
        'https://studio.demo/api/studio/image-library?businessId=biz-leeds-sourdough&source=STOCK&limit=100',
      ),
    );
    const { data } = (await res.json()) as {
      data: Array<{ sourceProvider: string; licenseNotes: string; sourceUrl: string | null }>;
    };
    expect(data.length).toBeGreaterThan(5);
    for (const image of data) {
      expect(image.sourceProvider).toBe('pixabay');
      expect(image.licenseNotes).toContain('Pixabay Content License');
      expect(image.sourceUrl).toMatch(/^https:\/\/pixabay\.com\/photos\//);
    }
  });
});
