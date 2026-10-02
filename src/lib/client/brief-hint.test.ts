import { describe, expect, it } from 'vitest';
import { isVagueBrief, meaningfulWordCount, MIN_MEANINGFUL_WORDS } from './brief-hint';

describe('meaningfulWordCount', () => {
  it('ignores filler and the words for video, post and content', () => {
    expect(meaningfulWordCount('make me a video')).toBe(0);
    expect(meaningfulWordCount('Please create some content for my post')).toBe(0);
  });

  it('counts the specific words', () => {
    expect(meaningfulWordCount('space video')).toBe(1);
    expect(meaningfulWordCount('social media automation platform.')).toBe(4);
    expect(
      meaningfulWordCount('A 30-second reel showing our new autumn pastries for office workers'),
    ).toBeGreaterThanOrEqual(6);
  });

  it('keeps numbers and hyphenated or apostrophe words as one word', () => {
    expect(meaningfulWordCount('2 for 1')).toBe(2);
    expect(meaningfulWordCount("mother's-day brunch")).toBe(2);
  });

  it('counts words in non-Latin scripts that use spaces', () => {
    expect(meaningfulWordCount('مخبز الشام يقدم كعك العيد الطازج')).toBe(6);
    expect(meaningfulWordCount('हमारी बेकरी की नई दिवाली मिठाइयाँ')).toBe(5);
    expect(meaningfulWordCount('فيديو')).toBe(0);
  });

  it('counts Chinese and Japanese by characters, so a sentence is never penalised', () => {
    expect(meaningfulWordCount('为我们的咖啡店制作秋季新品宣传视频')).toBeGreaterThanOrEqual(
      MIN_MEANINGFUL_WORDS,
    );
    expect(meaningfulWordCount('秋の新作スイーツを紹介する動画')).toBeGreaterThanOrEqual(
      MIN_MEANINGFUL_WORDS,
    );
    expect(meaningfulWordCount('做一个视频')).toBe(0);
  });

  it('separates CJK from Latin letters in one run', () => {
    expect(meaningfulWordCount('AI视频')).toBe(1);
  });
});

describe('isVagueBrief', () => {
  it('is false for an empty brief (nothing typed yet)', () => {
    expect(isVagueBrief('')).toBe(false);
    expect(isVagueBrief('   ')).toBe(false);
    expect(isVagueBrief(null)).toBe(false);
    expect(isVagueBrief(undefined)).toBe(false);
  });

  it('flags the production briefs and generic requests', () => {
    expect(isVagueBrief('space video')).toBe(true);
    expect(isVagueBrief('make a video')).toBe(true);
    expect(isVagueBrief('hi')).toBe(true);
    expect(isVagueBrief('content')).toBe(true);
    expect(isVagueBrief('vidéo pour Noël')).toBe(true);
  });

  it('does not flag a brief with enough detail', () => {
    expect(isVagueBrief('social media automation platform.')).toBe(false);
    expect(
      isVagueBrief('Show busy parents how our meal kits get dinner on the table in 20 minutes'),
    ).toBe(false);
    expect(isVagueBrief('Nuestra panadería presenta el roscón de Reyes artesanal')).toBe(false);
    expect(isVagueBrief('为我们的咖啡店制作秋季新品宣传视频，面向年轻上班族')).toBe(false);
  });
});
