import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  actorDescription,
  isUgcLanguage,
  newUgcStyle,
  ugcInput,
  ugcStyleOf,
  UGC_GENDERS,
  UGC_SETTINGS,
} from './style';

describe('UGC style (21.4)', () => {
  it('keeps the owner’s choices and fills the rest from the seed, deterministically', () => {
    const chosen = newUgcStyle(
      {
        product: { name: 'Oat latte kit', imageId: 'img-1' },
        actor: { ageRange: '18-24', gender: 'man', setting: 'car' },
      },
      99,
    );
    expect(chosen).toEqual({
      style: 'UGC_ACTOR',
      product: { name: 'Oat latte kit', imageId: 'img-1' },
      actor: { ageRange: '18-24', gender: 'man', setting: 'car' },
      seed: 99,
    });
    const open = newUgcStyle({}, 12345);
    expect(newUgcStyle({}, 12345)).toEqual(open);
    expect(UGC_GENDERS).toContain(open.actor.gender);
    expect(UGC_SETTINGS).toContain(open.actor.setting);
    expect(open.product).toEqual({ name: null, imageId: null });
  });

  it('clamps the seed into the signed 31-bit range', () => {
    expect(newUgcStyle({}, -5).seed).toBe(0);
    expect(newUgcStyle({}, 2 ** 40).seed).toBe(2 ** 31 - 1);
  });

  it('describes the same person word for word for the same style, different for other seeds', () => {
    const a = newUgcStyle({ actor: { gender: 'woman', ageRange: '25-34' } }, 1);
    expect(actorDescription(a)).toBe(actorDescription({ ...a }));
    expect(actorDescription(a)).toMatch(/^a woman around thirty with .+, wearing .+$/);
    const descriptions = new Set(
      Array.from({ length: 12 }, (_, i) => actorDescription({ ...a, seed: i * 7919 })),
    );
    expect(descriptions.size).toBeGreaterThan(3);
  });

  it('reads metadata.ugc back, and nothing for other projects or malformed values', () => {
    const style = newUgcStyle({}, 3);
    expect(ugcStyleOf({ ugc: { ...style }, other: 1 } as unknown as Prisma.JsonObject)).toEqual(
      style,
    );
    expect(ugcStyleOf({})).toBeNull();
    expect(ugcStyleOf(null)).toBeNull();
    expect(
      ugcStyleOf({ ugc: { ...style, style: 'OTHER' } } as unknown as Prisma.JsonObject),
    ).toBeNull();
    expect(
      ugcStyleOf({
        ugc: { ...style, actor: { ...style.actor, setting: 'moon' } },
      } as unknown as Prisma.JsonObject),
    ).toBeNull();
  });

  it('validates the request body strictly', () => {
    expect(ugcInput.safeParse({}).success).toBe(true);
    expect(ugcInput.safeParse({ actor: { gender: 'any' } }).success).toBe(false);
    expect(ugcInput.safeParse({ product: { name: 'x'.repeat(121) } }).success).toBe(false);
    expect(ugcInput.safeParse({ extra: true }).success).toBe(false);
  });

  it('English only for now', () => {
    expect(isUgcLanguage('en-GB')).toBe(true);
    expect(isUgcLanguage('en-US')).toBe(true);
    expect(isUgcLanguage(undefined)).toBe(true);
    expect(isUgcLanguage('fr')).toBe(false);
  });
});
