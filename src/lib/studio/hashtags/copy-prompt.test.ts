import { describe, expect, it } from 'vitest';
import { PLATFORMS } from '../services/catalog';
import {
  CAPTION_RULES,
  PLATFORM_GUIDANCE,
  socialCopyPromptLines,
  socialPostSchema,
  upcomingMoments,
} from './copy-prompt';

describe('social copy prompt (20.13)', () => {
  it('has guidance for every platform; X leaves room for five hashtags', () => {
    for (const p of PLATFORMS) expect(PLATFORM_GUIDANCE[p]).toBeTruthy();
    expect(PLATFORM_GUIDANCE.x).toContain('five hashtags');
    expect(PLATFORM_GUIDANCE.youtube_short).toContain('#Shorts');
  });

  it('never lets the model claim trends or invent offers', () => {
    const rules = CAPTION_RULES.join(' ');
    expect(rules).toContain('"trending"');
    expect(rules).toContain('Never invent prices');
    expect(rules).toContain('own account');
  });

  it('lists the hashtags Studio adds itself, the facts fenced as data, and the moments', () => {
    const lines = socialCopyPromptLines({
      platforms: ['tiktok', 'x'],
      policy: { business: 'AheadAI', always: ['LeedsEats'] },
      facts: { businessName: 'Ahead """AI', industry: 'bakery', regions: ['Leeds'] },
      restrictedTopics: ['alcohol'],
      moments: ['Halloween (Saturday 31 October)'],
    }).join('\n');
    expect(lines).toContain('- tiktok:');
    expect(lines).toContain('- x:');
    expect(lines).toContain('do not repeat them: #AheadAI #LeedsEats');
    expect(lines).toContain('Restricted topics (never mention): alcohol');
    expect(lines).toContain('Business: Ahead "AI');
    expect(lines).toContain('Halloween (Saturday 31 October)');
    expect(lines).toContain('10 relevant hashtags');
  });

  it('omits empty sections', () => {
    const lines = socialCopyPromptLines({
      platforms: ['tiktok'],
      policy: { business: null, always: [] },
    }).join('\n');
    expect(lines).not.toContain('Studio adds these');
    expect(lines).not.toContain('Business facts');
    expect(lines).not.toContain('Timely moments');
  });

  it('upcomingMoments lists UK calendar days in the next three weeks', () => {
    const at = Date.UTC(2026, 9, 20, 12); // 20 October 2026
    expect(upcomingMoments(at)).toEqual([
      'Halloween (Saturday 31 October)',
      'Bonfire Night (Thursday 5 November)',
    ]);
    expect(upcomingMoments(Date.UTC(2026, 6, 1), 7)).toEqual([]);
  });

  it('parses a social post, defaulting hashtags', () => {
    expect(socialPostSchema.parse({ platform: 'x', caption: 'Hi' })).toEqual({
      platform: 'x',
      caption: 'Hi',
      hashtags: [],
    });
  });
});
