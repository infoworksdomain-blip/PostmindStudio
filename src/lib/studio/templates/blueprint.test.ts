import { describe, expect, it, vi } from 'vitest';
import { INTRODUCE_YOURSELF } from './seed';
import {
  blueprintFromShots,
  loadTemplateGuide,
  renderScriptTemplate,
  shotTypeFor,
  templateBlueprint,
  toBlueprint,
  type ShotShape,
} from './blueprint';

const shot = (overrides: Partial<ShotShape> = {}): ShotShape => ({
  durationSec: 5,
  visualTreatment: 'AI_CLIP',
  voiceoverText: 'Hello',
  onScreenText: null,
  overlayPresetNames: [],
  ...overrides,
});

describe('shotTypeFor', () => {
  it('maps the opening text still to a hook and the closing text card to a CTA', () => {
    expect(shotTypeFor('TEXT_CARD', 0, 3, true)).toBe('HOOK_TEXT_ON_STILL');
    expect(shotTypeFor('TEXT_CARD', 2, 3, true)).toBe('CTA_CARD');
    expect(shotTypeFor('TEXT_CARD', 1, 3, false)).toBe('TEXT_CARD');
  });

  it.each([
    ['AI_AVATAR', 'AVATAR_TALKING'],
    ['STOCK_FOOTAGE', 'STOCK_LIFESTYLE'],
    ['IMAGE_STILL', 'PRODUCT_SHOT'],
    ['MOTION_GRAPHICS', 'SCREEN_RECORDING'],
    ['AI_CLIP', 'AI_CLIP_ACTION'],
    ['USER_UPLOAD', 'AI_CLIP_ACTION'],
  ])('%s → %s', (treatment, type) => {
    expect(shotTypeFor(treatment, 1, 3, false)).toBe(type);
  });
});

describe('blueprintFromShots', () => {
  it('keeps structure (durations, roles, overlay styles, voice/text) and no words', () => {
    const blueprint = blueprintFromShots([
      shot({
        visualTreatment: 'IMAGE_STILL',
        onScreenText: 'Secret recipe',
        overlayPresetNames: ['hook_bold_centre'],
        durationSec: 2.04,
      }),
      shot({ visualTreatment: 'AI_CLIP', voiceoverText: null }),
      shot({ visualTreatment: 'TEXT_CARD', onScreenText: 'Order now', durationSec: 2 }),
    ]);
    expect(templateBlueprint.parse(blueprint)).toEqual(blueprint);
    expect(blueprint.shots).toEqual([
      {
        durationSec: 2,
        type: 'HOOK_TEXT_ON_STILL',
        overlayStyle: 'bold-centre',
        voiceoverPresent: true,
        hasOnScreenText: true,
      },
      {
        durationSec: 5,
        type: 'AI_CLIP_ACTION',
        overlayStyle: 'none',
        voiceoverPresent: false,
        hasOnScreenText: false,
      },
      {
        durationSec: 2,
        type: 'CTA_CARD',
        overlayStyle: 'none',
        voiceoverPresent: true,
        hasOnScreenText: true,
      },
    ]);
    expect(blueprint.ctaPattern).toBe('closing call-to-action card');
    expect(JSON.stringify(blueprint)).not.toMatch(/Secret recipe|Order now|Hello/);
  });

  it('derives pace from the average shot length', () => {
    expect(blueprintFromShots([shot({ durationSec: 1.5 })]).paceTag).toBe('fast-cut');
    expect(blueprintFromShots([shot({ durationSec: 4 })]).paceTag).toBe('medium');
    expect(blueprintFromShots([shot({ durationSec: 8 })]).paceTag).toBe('slow');
  });
});

describe('renderScriptTemplate', () => {
  it('substitutes {{vars}}, empties unknown ones and flattens values', () => {
    expect(
      renderScriptTemplate('Introduce {{ name }} in {{city}}. {{missing}}Done.', {
        name: 'Leeds <b>Sourdough</b>',
        city: 'Leeds\n\nYorkshire',
      }),
    ).toBe('Introduce Leeds bSourdough/b in Leeds Yorkshire. Done.');
  });

  it('does not resolve prototype properties', () => {
    expect(renderScriptTemplate('x {{constructor}} y', {})).toBe('x y');
  });
});

describe('the built-in "Introduce yourself" template', () => {
  it('has a valid 30-second blueprint', () => {
    const parsed = templateBlueprint.parse(INTRODUCE_YOURSELF.shotBlueprint);
    expect(toBlueprint(parsed)).toMatchObject({ shotCount: 5, totalDurationSec: 30 });
  });
});

describe('loadTemplateGuide', () => {
  const project = { sourceType: 'TEMPLATE' as const, templateId: 't1', organisationId: 'org' };

  it('turns the template blueprint into a TEMPLATE-mode guide', async () => {
    const findFirst = vi.fn(async () => ({
      id: 't1',
      shotBlueprint: INTRODUCE_YOURSELF.shotBlueprint,
    }));
    const guide = await loadTemplateGuide({ template: { findFirst } } as never, project);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 't1', OR: [{ organisationId: null }, { organisationId: 'org' }] },
      select: { id: true, shotBlueprint: true },
    });
    expect(guide).toMatchObject({ mode: 'TEMPLATE', templateId: 't1', referenceVideoId: null });
    expect(guide?.scriptSupplement(30, ['AI_CLIP', 'TEXT_CARD'])).toContain('Exactly 5 shots');
    expect(guide?.presetForShot(0)).toBe('hook_bold_centre');
  });

  it('returns null for other sources and for unusable blueprints', async () => {
    const findFirst = vi.fn(async () => ({ id: 't1', shotBlueprint: { shots: [] } }));
    const db = { template: { findFirst } } as never;
    expect(await loadTemplateGuide(db, { ...project, sourceType: 'BRIEF' })).toBeNull();
    expect(await loadTemplateGuide(db, project)).toBeNull();
  });
});
