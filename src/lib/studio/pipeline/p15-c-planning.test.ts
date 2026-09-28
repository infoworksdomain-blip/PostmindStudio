import { describe, expect, it } from 'vitest';
import {
  findLanguage,
  languageInput,
  extraLanguagesInput,
  LANGUAGES,
  languageInstruction,
  languageOf,
  projectLanguages,
} from '../languages';
import { buildIdeationPrompt } from './ideation';
import { PLATFORM_GUIDANCE, platformGuidanceBlock } from './platform-guidance';
import {
  buildScriptSafetyPrompt,
  escalatePublicFigure,
  parseScriptSafety,
  SAFETY_CATEGORIES,
  SCRIPT_SAFETY_SYSTEM_PROMPT,
} from './script-safety';
import {
  buildScriptPrompt,
  mergePinnedShots,
  pinnedShotsSupplement,
  type PlannedShot,
} from './scripting';
import type { IdeationResult } from './ideation';

// Phase 15 Track C — planning inputs: languages (15.C5), public-figure review (15.C6),
// platform guidance (15.C8) and pinned shots (15.C9).

const brief: IdeationResult = {
  actionable: true,
  directionOptions: [],
  hook: 'Friday means sourdough',
  keyMessage: 'Fresh loaves every Friday',
  targetAudience: 'Local families',
  tone: 'warm',
  callToAction: 'Pre-order today',
  keywords: ['bakery'],
  restrictedTopicsMentioned: [],
};
const tiktok = { platform: 'tiktok', aspectRatio: '9:16' as const, durationSec: 30 };

describe('15.C5 languages', () => {
  it('supports exactly the operator list (no Nigerian Pidgin)', () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual([
      'en-GB',
      'en-US',
      'fr',
      'es',
      'ar',
      'de',
      'it',
      'pt-BR',
      'pt-PT',
      'hi',
      'zh-Hans',
    ]);
    expect(findLanguage('pcm')).toBeUndefined();
  });

  it('validates and canonicalises tags; rejects unsupported ones', () => {
    expect(languageInput.parse('pt-br')).toBe('pt-BR');
    expect(languageInput.parse('ZH-hans')).toBe('zh-Hans');
    expect(languageInput.safeParse('pcm').success).toBe(false);
    expect(languageInput.safeParse('en').success).toBe(false);
    expect(extraLanguagesInput.safeParse(['fr', 'fr']).success).toBe(false);
    expect(extraLanguagesInput.safeParse(['fr', 'es', 'de', 'it', 'ar']).success).toBe(false);
  });

  it('knows script and direction per language', () => {
    expect(languageOf('ar')).toMatchObject({ direction: 'rtl', script: 'arabic' });
    expect(languageOf('hi').script).toBe('devanagari');
    expect(languageOf('zh-Hans').script).toBe('han');
    expect(languageOf(null).code).toBe('en-GB');
    expect(languageOf('xx').code).toBe('en-GB');
  });

  it('lists the primary language first, extras deduplicated and filtered', () => {
    expect(projectLanguages('fr', ['es', 'fr', 'pcm', 'pt-br', 7])).toEqual(['fr', 'es', 'pt-BR']);
    expect(projectLanguages(undefined, undefined)).toEqual(['en-GB']);
  });

  it.each(LANGUAGES.map((l) => [l.code, l.promptName]))(
    '%s: Layers 1 and 2 are told to write natively in %s',
    (code, promptName) => {
      const script = buildScriptPrompt({
        brief,
        format: tiktok,
        treatments: ['AI_CLIP'],
        restrictedTopics: [],
        language: code,
      });
      expect(script).toContain(promptName);
      expect(script).toContain('Do not translate from English');
      const ideation = buildIdeationPrompt({
        rawInput: 'Promote Friday bread',
        targetPlatforms: ['tiktok'],
        language: code,
      });
      expect(ideation).toContain(promptName);
    },
  );

  it('adds the right-to-left note for Arabic only', () => {
    expect(languageInstruction('ar')).toContain('right-to-left');
    expect(languageInstruction('fr')).not.toContain('right-to-left');
  });

  it('defaults to British English', () => {
    const script = buildScriptPrompt({
      brief,
      format: tiktok,
      treatments: ['AI_CLIP'],
      restrictedTopics: [],
    });
    expect(script).toContain('British English');
  });
});

describe('15.C6 public-figure review flag', () => {
  it('is a safety category the classifier is told about', () => {
    expect(SAFETY_CATEGORIES).toContain('public_figure');
    expect(SCRIPT_SAFETY_SYSTEM_PROMPT).toContain('public_figure');
  });

  it.each(['ALLOW', 'WARN'] as const)('raises %s to REVIEW when a real person is named', (v) => {
    const result = parseScriptSafety({
      verdict: v,
      categories: ['public_figure'],
      reason: 'Mentions a footballer',
    });
    expect(result.verdict).toBe('REVIEW');
    expect(result.reason).toContain('public figure');
  });

  it('keeps BLOCK and plain ALLOW as they are', () => {
    const block = {
      verdict: 'BLOCK' as const,
      categories: ['public_figure' as const],
      reason: 'x',
    };
    expect(escalatePublicFigure(block)).toBe(block);
    expect(parseScriptSafety({ verdict: 'ALLOW', categories: [], reason: '' }).verdict).toBe(
      'ALLOW',
    );
  });

  it('labels each script with its platform', () => {
    expect(
      buildScriptSafetyPrompt([{ platform: 'tiktok (ar)', fullText: 'مرحبا', onScreenText: [] }]),
    ).toContain('tiktok (ar)');
  });
});

describe('15.C8 platform-native guidance', () => {
  it('states the spec 5.3 engagement curve and per-platform hook framing', () => {
    const block = platformGuidanceBlock('tiktok', 30);
    expect(block).toContain('21–34 seconds');
    expect(block).toContain('this video is inside it');
    expect(block).toMatch(/First 1\.5 seconds/);
    expect(platformGuidanceBlock('youtube_short', 30)).toContain('45–60 seconds');
    expect(platformGuidanceBlock('youtube_short', 30)).toContain("owner's choice");
    expect(platformGuidanceBlock('youtube', 300)).toContain('4–8 minutes');
  });

  it('frames the TikTok and Reels hooks differently (spec 5.8)', () => {
    expect(PLATFORM_GUIDANCE.tiktok?.hook).not.toBe(PLATFORM_GUIDANCE.instagram_reel?.hook);
    expect(PLATFORM_GUIDANCE.instagram_reel?.captions).toContain('burned');
  });

  it('is part of the Layer 2 prompt; unknown platforms get none', () => {
    expect(
      buildScriptPrompt({ brief, format: tiktok, treatments: ['AI_CLIP'], restrictedTopics: [] }),
    ).toContain('Platform guidance (tiktok)');
    expect(platformGuidanceBlock('myspace', 30)).toBe('');
  });
});

describe('15.C9 pinned shots', () => {
  const shot = (label: string): PlannedShot => ({
    sortOrder: 0,
    durationSec: 5,
    visualTreatment: 'AI_CLIP',
    sceneDescription: label,
    cameraDirection: null,
    voiceoverText: label,
    onScreenText: null,
    transitionOut: 'cut',
  });

  it('keeps pinned shots at their positions and fills the gaps in order', () => {
    const merged = mergePinnedShots(
      [shot('a'), shot('b'), shot('c')],
      [
        { position: 3, id: 'p3' },
        { position: 0, id: 'p0' },
      ],
    );
    expect(merged.map((m) => (m.kind === 'pinned' ? m.shot.id : m.shot.sceneDescription))).toEqual([
      'p0',
      'a',
      'b',
      'p3',
      'c',
    ]);
  });

  it('clamps a pinned position past the end', () => {
    const merged = mergePinnedShots([shot('a')], [{ position: 7, id: 'p7' }]);
    expect(merged.map((m) => m.kind)).toEqual(['new', 'pinned']);
  });

  it('tells Layer 2 what is kept and how long to write', () => {
    const text = pinnedShotsSupplement(
      [
        {
          position: 1,
          durationSec: 6,
          sceneDescription: 'Loaves "cooling"',
          voiceoverText: 'Fresh every Friday',
          onScreenText: null,
        },
      ],
      30,
    );
    expect(text).toContain('Position 2 (6s)');
    expect(text).toContain("Loaves 'cooling'");
    expect(text).toContain('lasting 24 seconds');
    expect(pinnedShotsSupplement([], 30)).toBe('');
  });
});
