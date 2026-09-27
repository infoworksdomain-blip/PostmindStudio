import { describe, expect, it } from 'vitest';
import type { SlideContent } from '../../slideshow/planner';
import { slideText } from './plan-slideshow';

describe('slideText', () => {
  it('returns [] for empty content', () => {
    expect(slideText({})).toEqual([]);
  });

  it('collects text, caption, quote and author when present', () => {
    const content: SlideContent = {
      text: 'hello',
      caption: 'a caption',
      quote: 'a quote',
      author: 'Jane',
    };
    expect(slideText(content)).toEqual(['hello', 'a caption', 'a quote', 'Jane']);
  });

  it('combines value and label into one entry only when both are present', () => {
    expect(slideText({ value: '98%', label: 'satisfaction' })).toEqual(['98% satisfaction']);
    expect(slideText({ value: '98%' })).toEqual([]);
    expect(slideText({ label: 'satisfaction' })).toEqual([]);
  });

  it('includes name, features and price for a PRODUCT slide', () => {
    const content: SlideContent = {
      name: 'Widget',
      features: ['durable', 'cheap'],
      price: '$9.99',
    };
    expect(slideText(content)).toEqual(['Widget', 'durable', 'cheap', '$9.99']);
  });

  it('filters out falsy/empty-string fields', () => {
    const content: SlideContent = { text: '', caption: undefined, name: 'Widget' };
    expect(slideText(content)).toEqual(['Widget']);
  });

  it('omits features when the array is empty', () => {
    expect(slideText({ features: [] })).toEqual([]);
  });
});
