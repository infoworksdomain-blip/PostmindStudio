import { describe, expect, it } from 'vitest';
import {
  aspectOfItem,
  durationOfItem,
  posterOfItem,
  projectOfItem,
  resolveFilter,
  sizeOfItem,
  withFilter,
} from './media-model';
import { imageItem, uploadItem, videoItem } from './test-fixtures';

describe('media model', () => {
  it('reads the segment from the URL and writes it back', () => {
    expect(resolveFilter('image')).toBe('image');
    expect(resolveFilter('fonts')).toBe('all');
    expect(resolveFilter(null)).toBe('all');
    expect(withFilter('type=video&x=1', 'all')).toBe('?x=1');
    expect(withFilter('', 'upload')).toBe('?type=upload');
    expect(withFilter('type=upload', 'all')).toBe('');
  });

  it('gives each item its shape, still, length and project', () => {
    expect(aspectOfItem(videoItem({ aspectRatio: '16:9' }))).toBe('16:9');
    expect(aspectOfItem(uploadItem({ width: 1920, height: 1080 }))).toBe('16:9');
    expect(aspectOfItem(uploadItem({ width: null, height: null }))).toBe('9:16');
    expect(aspectOfItem(imageItem({ widthPx: 1600, heightPx: 1600 }))).toBe('1:1');
    expect(sizeOfItem(imageItem())).toEqual({ width: 1600, height: 1200 });
    expect(sizeOfItem(uploadItem({ width: null }))).toBeNull();
    expect(posterOfItem(videoItem())).toBe('https://cdn.test/thumb.jpg');
    expect(posterOfItem(uploadItem())).toBeNull();
    expect(posterOfItem(imageItem())).toBe('https://cdn.test/img.jpg');
    expect(durationOfItem(imageItem())).toBeNull();
    expect(durationOfItem(videoItem())).toBe(21);
    expect(projectOfItem(videoItem())).toBe('proj_1');
    expect(projectOfItem(imageItem())).toBeNull();
  });
});
