import { describe, expect, it } from 'vitest';
import type { LibraryImage } from '../business/types';
import { generateBody, isValidRequest, nearestAspect, requestOf } from './image-studio-model';

const image = (over: Partial<LibraryImage> = {}): LibraryImage => ({
  id: 'img_1',
  businessId: 'biz_1',
  source: 'GENERATED',
  sourceUrl: null,
  sourceProvider: 'dalle-3',
  publicUrl: null,
  previewUrl: 'https://cdn.test/img_1.png',
  hotlinked: false,
  widthPx: 1024,
  heightPx: 1792,
  fileSizeBytes: 100_000,
  tags: [],
  altText: 'Sourdough on a board',
  generatedFromPrompt:
    'Sourdough on a board\nStyle: warm film\nBrand context: bakery; themes: bread\nNo text, logos or watermarks in the image.',
  licenseNotes: null,
  useCount: 0,
  createdAt: '2026-10-07T10:00:00.000Z',
  ...over,
});

describe('image studio model', () => {
  it('sends exactly the fields the API accepts, without an empty style', () => {
    expect(generateBody('biz_1', { prompt: '  A loaf  ', style: ' ', aspectRatio: '4:5' })).toEqual(
      { businessId: 'biz_1', prompt: 'A loaf', aspectRatio: '4:5' },
    );
    expect(generateBody('biz_1', { prompt: 'A loaf', style: 'film', aspectRatio: '1:1' })).toEqual({
      businessId: 'biz_1',
      prompt: 'A loaf',
      style: 'film',
      aspectRatio: '1:1',
    });
  });

  it('validates the prompt length (3–1000) and the style length (≤200)', () => {
    expect(isValidRequest({ prompt: 'ab', style: '' })).toBe(false);
    expect(isValidRequest({ prompt: '  abc ', style: '' })).toBe(true);
    expect(isValidRequest({ prompt: 'x'.repeat(1001), style: '' })).toBe(false);
    expect(isValidRequest({ prompt: 'abc', style: 's'.repeat(201) })).toBe(false);
  });

  it('maps an image size to the nearest shape', () => {
    expect(nearestAspect(1024, 1024)).toBe('1:1');
    expect(nearestAspect(1024, 1792)).toBe('9:16');
    expect(nearestAspect(1792, 1024)).toBe('16:9');
    expect(nearestAspect(1024, 1280)).toBe('4:5');
    expect(nearestAspect(0, 10)).toBe('1:1');
  });

  it('reads what a generated image was made from', () => {
    expect(requestOf(image())).toEqual({
      prompt: 'Sourdough on a board',
      style: 'warm film',
      aspectRatio: '9:16',
    });
    expect(requestOf(image({ generatedFromPrompt: 'Plain prompt' }))?.style).toBe('');
    expect(requestOf(image({ source: 'UPLOAD' }))).toBeNull();
    expect(
      requestOf(image({ altText: null, generatedFromPrompt: 'From full\nStyle: x' }))?.prompt,
    ).toBe('From full');
  });
});
