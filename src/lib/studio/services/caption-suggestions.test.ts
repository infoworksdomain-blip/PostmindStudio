import { describe, expect, it } from 'vitest';
import { PLATFORMS } from './catalog';
import { buildPrompt, fitSuggestion, PLATFORM_GUIDANCE } from './caption-suggestions';

describe('caption suggestions (15.A7)', () => {
  it('has spec 9.8 guidance for every platform', () => {
    for (const p of PLATFORMS) expect(PLATFORM_GUIDANCE[p]).toBeTruthy();
  });

  it('asks for captions and hashtags in the project language, brief fenced as data', () => {
    const prompt = buildPrompt({
      language: 'fr',
      platforms: ['tiktok', 'x'],
      brief: {
        hook: 'Le vendredi, c’est sourdough',
        keyMessage: 'Pain frais',
        targetAudience: 'Leeds',
        tone: 'chaleureux',
        callToAction: null,
        keywords: ['pain'],
      },
    });
    expect(prompt).toContain('in the language fr');
    expect(prompt).toContain('- tiktok:');
    expect(prompt).toContain('- x:');
    expect(prompt).toContain('"""');
    expect(prompt).not.toContain('Call to action');
  });

  it('clamps model output to platform rules', () => {
    const x = fitSuggestion('x', {
      platform: 'x',
      caption: 'word '.repeat(100),
      hashtags: ['#one', 'two', 'three words', 'four'],
    });
    expect(x.hashtags).toEqual(['one', 'two']);
    expect(x.captionTruncated).toBe(true);

    const shorts = fitSuggestion('youtube_short', {
      platform: 'youtube_short',
      caption: 'Line one\nmore',
      hashtags: ['Shorts', 'bread'],
      title: '<b>' + 'T'.repeat(150),
    });
    expect(shorts.hashtags).toEqual(['bread']);
    expect(shorts.title).toHaveLength(100);
    expect(shorts.title).not.toContain('<');

    const tiktok = fitSuggestion('tiktok', { platform: 'tiktok', caption: 'Hi', hashtags: [] });
    expect(tiktok).toEqual({ caption: 'Hi', hashtags: [] });
  });
});
