import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import {
  BUSINESS_HASHTAG_MAX_CHARS,
  deriveBusinessHashtag,
  hashtagProblem,
  phraseToHashtag,
  validateBusinessHashtag,
} from './business-hashtag';

describe('deriveBusinessHashtag (20.13)', () => {
  it('turns the business name into one CamelCase hashtag ("AheadAi" → AheadAI)', () => {
    expect(deriveBusinessHashtag('AheadAi')).toBe('AheadAI');
    expect(deriveBusinessHashtag('ahead ai')).toBe('AheadAI');
    expect(deriveBusinessHashtag('Leeds Sourdough')).toBe('LeedsSourdough');
  });

  it('drops legal suffixes, apostrophes and punctuation', () => {
    expect(deriveBusinessHashtag('Leeds Sourdough Ltd')).toBe('LeedsSourdough');
    expect(deriveBusinessHashtag("Jo's Café & Bakery Limited")).toBe('JosCaféBakery');
    expect(deriveBusinessHashtag('Smith-Jones Plumbing, Co.')).toBe('SmithJonesPlumbing');
  });

  it('keeps mixed-case brands and short acronyms, tames shouting', () => {
    expect(deriveBusinessHashtag('iPhone Repairs')).toBe('iPhoneRepairs');
    expect(deriveBusinessHashtag('BBC Bakes')).toBe('BBCBakes');
    expect(deriveBusinessHashtag('LEEDS SOURDOUGH')).toBe('LeedsSourdough');
    expect(deriveBusinessHashtag('the diy shop')).toBe('TheDIYShop');
  });

  it('keeps non-Latin scripts as written (no transliteration)', () => {
    expect(deriveBusinessHashtag('مخبز الشام')).toBe('مخبزالشام');
    expect(deriveBusinessHashtag('दिल्ली बेकरी')).toBe('दिल्लीबेकरी');
    expect(deriveBusinessHashtag('上海 面包')).toBe('上海面包');
  });

  it('stays within 30 characters, dropping whole trailing words', () => {
    const tag = deriveBusinessHashtag('The Extraordinarily Long Named Artisan Bakery Company');
    expect(tag).toBe('TheExtraordinarilyLongNamed');
    expect([...(tag ?? '')].length).toBeLessThanOrEqual(BUSINESS_HASHTAG_MAX_CHARS);
    expect(deriveBusinessHashtag('A'.repeat(40) + 'b')).toHaveLength(30);
  });

  it('has no default for names without letters', () => {
    expect(deriveBusinessHashtag('123')).toBeNull();
    expect(deriveBusinessHashtag('!!!')).toBeNull();
    expect(deriveBusinessHashtag('')).toBeNull();
    expect(deriveBusinessHashtag(null)).toBeNull();
  });
});

describe('business hashtag validation', () => {
  it('accepts letters, digits and underscores (any script), strips #', () => {
    expect(validateBusinessHashtag('#AheadAI')).toBe('AheadAI');
    expect(validateBusinessHashtag('cafe_2026')).toBe('cafe_2026');
    expect(validateBusinessHashtag('मुंबईकेक')).toBe('मुंबईकेक');
  });

  it('names the problem', () => {
    expect(hashtagProblem('two words', 30)).toBe('characters');
    expect(hashtagProblem('dash-tag', 30)).toBe('characters');
    expect(hashtagProblem('#', 30)).toBe('empty');
    expect(hashtagProblem('2026', 30)).toBe('needs_letter');
    expect(hashtagProblem('a'.repeat(31), 30)).toBe('too_long');
    expect(() => validateBusinessHashtag('no spaces please')).toThrow(ValidationError);
  });

  it('phraseToHashtag makes profile phrases usable', () => {
    expect(phraseToHashtag('small business')).toBe('SmallBusiness');
    expect(phraseToHashtag('West Yorkshire')).toBe('WestYorkshire');
    expect(phraseToHashtag('—')).toBeNull();
  });
});
