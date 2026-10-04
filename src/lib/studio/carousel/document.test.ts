import { describe, expect, it } from 'vitest';
import {
  carouselCreateInput,
  carouselEditInput,
  handleInput,
  readCarousel,
  toDocument,
} from './document';

const stored = {
  version: 1,
  theme: 'dark',
  language: 'ar',
  profile: { displayName: 'Acme', handle: 'acme', logoUploadId: null },
  posts: [
    { id: 'p1', text: 'Hook', image: { imageId: 'i', width: 10, height: 10, aiGenerated: true } },
  ],
};

describe('carousel documents', () => {
  it('reads metadata.carousel with defaults and returns null otherwise', () => {
    const read = readCarousel({ carousel: stored });
    expect(read).toMatchObject({ postCount: 7, aiWritten: false, rewrites: 0 });
    expect(readCarousel({ carousel: { ...stored, version: 2 } })).toBeNull();
    expect(readCarousel(null)).toBeNull();
    expect(readCarousel([])).toBeNull();
  });

  it('turns the stored carousel into the render document', () => {
    const read = readCarousel({ carousel: stored });
    if (!read) throw new Error('not read');
    expect(toDocument(read)).toEqual({
      version: 1,
      theme: 'dark',
      language: 'ar',
      profile: stored.profile,
      posts: [{ id: 'p1', text: 'Hook', image: stored.posts[0]?.image }],
    });
  });

  it('accepts handles with or without @ and refuses spaces', () => {
    expect(handleInput.parse('@acme.bakes')).toBe('acme.bakes');
    expect(handleInput.parse('')).toBe('');
    expect(handleInput.safeParse('acme bakes').success).toBe(false);
  });

  it('validates create options with defaults', () => {
    expect(carouselCreateInput.parse({})).toEqual({ theme: 'light', postCount: 7 });
    expect(carouselCreateInput.safeParse({ postCount: 13 }).success).toBe(false);
    expect(carouselCreateInput.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('refuses duplicate post ids and empty names in an edit', () => {
    const edit = {
      theme: 'light',
      profile: { displayName: 'Acme', handle: 'acme' },
      posts: [
        { id: 'a', text: 'x', imageId: null },
        { id: 'a', text: 'y', imageId: null },
      ],
    };
    expect(carouselEditInput.safeParse(edit).success).toBe(false);
    expect(
      carouselEditInput.safeParse({
        ...edit,
        profile: { displayName: ' ', handle: '' },
        posts: [{ id: 'a', text: 'x', imageId: null }],
      }).success,
    ).toBe(false);
  });
});
