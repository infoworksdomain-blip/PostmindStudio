import { describe, expect, it } from 'vitest';
import { hashtagPool, profileHashtags, projectCopy, readCopyMap } from './pool';

const metadata = {
  postCopy: { tiktok: { caption: 'Owner text', hashtags: ['OwnerTag'] } },
  captionSuggestions: {
    suggestions: {
      tiktok: { caption: 'Generated', hashtags: ['AheadAI', 'bread'] },
      x: { caption: 'Short', hashtags: ['Leeds', 'bad tag'] },
    },
  },
};

describe('hashtag pool (20.13)', () => {
  it('reads owner and generated copy maps, dropping invalid tags', () => {
    const { owner, generated } = projectCopy(metadata);
    expect(owner.tiktok).toEqual({ caption: 'Owner text', hashtags: ['OwnerTag'] });
    expect(generated.x?.hashtags).toEqual(['Leeds']);
    expect(readCopyMap('nope')).toEqual({});
    expect(readCopyMap({ x: { hashtags: [] } })).toEqual({});
  });

  it('turns the business profile into tags, niche first', () => {
    expect(
      profileHashtags({
        industry: 'food and drink',
        subNiche: 'artisan bakery',
        regions: ['Leeds', 'West Yorkshire'],
        products: ['sourdough loaves'],
      }),
    ).toEqual(['ArtisanBakery', 'FoodAndDrink', 'Leeds', 'WestYorkshire', 'SourdoughLoaves']);
    expect(profileHashtags(null)).toEqual([]);
  });

  it('orders the pool: this platform, other suggestions, owner copy, keywords, profile', () => {
    expect(
      hashtagPool('tiktok', {
        metadata,
        keywords: ['fresh bread', 42],
        profile: { subNiche: 'bakery' },
      }),
    ).toEqual(['AheadAI', 'bread', 'Leeds', 'FreshBread', 'Bakery']);
  });
});
