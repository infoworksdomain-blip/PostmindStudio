import type { PrismaClient, VideoProject } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError } from '../../errors';
import { loadReferenceGuide } from './reference';

// BACKLOG 9.5 — how a LIBRARY_REFERENCE project's reference shapes planning (A3.6 / A3.7).

function fakeDb(findFirstResult: unknown) {
  const videoLibraryItem = { findFirst: vi.fn(async () => findFirstResult) };
  return { db: { videoLibraryItem } as unknown as PrismaClient, videoLibraryItem };
}

type ProjectInput = Pick<VideoProject, 'sourceType' | 'referenceVideoId' | 'referenceMode'>;

function project(overrides: Partial<ProjectInput> = {}): ProjectInput {
  return {
    sourceType: 'LIBRARY_REFERENCE' as VideoProject['sourceType'],
    referenceVideoId: 'lib-1',
    referenceMode: 'TEMPLATE' as VideoProject['referenceMode'],
    ...overrides,
  };
}

const analysis = {
  shots: [
    {
      startSec: 0,
      endSec: 2,
      type: 'HOOK_TEXT_ON_STILL',
      overlayStyle: 'bold-centre',
      onScreenText: 'Hi',
      voiceoverPresent: false,
    },
    {
      startSec: 2,
      endSec: 5,
      type: 'TALKING_HEAD',
      overlayStyle: 'none',
      onScreenText: '',
      voiceoverPresent: true,
    },
  ],
  musicEnvelope: { bpm: null, mood: 'calm', genre: 'lofi' },
  hookPattern: 'hook',
  structurePattern: 'structure',
  ctaPattern: 'cta',
  paceTag: 'medium',
  moodTag: 'calm',
};

const NOW = Date.parse('2026-09-27T00:00:00Z');

describe('loadReferenceGuide', () => {
  it('returns null for a non-LIBRARY_REFERENCE project without querying the db', async () => {
    const { db, videoLibraryItem } = fakeDb(null);
    const result = await loadReferenceGuide(db, project({ sourceType: 'BRIEF' as never }), NOW);
    expect(result).toBeNull();
    expect(videoLibraryItem.findFirst).not.toHaveBeenCalled();
  });

  it('throws ConflictError when the project is missing a reference video id or mode', async () => {
    const { db } = fakeDb(null);
    await expect(
      loadReferenceGuide(db, project({ referenceVideoId: null }), NOW),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      loadReferenceGuide(db, project({ referenceMode: null as never }), NOW),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('throws NotFoundError when the item is missing or has no analysis', async () => {
    const missing = fakeDb(null);
    await expect(loadReferenceGuide(missing.db, project(), NOW)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const noAnalysis = fakeDb({
      id: 'lib-1',
      analysis: null,
      license: { allowedModes: ['TEMPLATE'], licenseExpires: null },
    });
    await expect(loadReferenceGuide(noAnalysis.db, project(), NOW)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('throws NotFoundError for a retired item because findFirst filters retiredAt: null', async () => {
    const { db, videoLibraryItem } = fakeDb(null);
    await expect(loadReferenceGuide(db, project(), NOW)).rejects.toBeInstanceOf(NotFoundError);
    expect(videoLibraryItem.findFirst).toHaveBeenCalledWith({
      where: { id: 'lib-1', retiredAt: null },
      include: { analysis: true, license: true },
    });
  });

  it('builds an INSPIRE guide: identity apply, no preset, and a supplement for both ideation and script', async () => {
    const { db } = fakeDb({
      id: 'lib-1',
      analysis,
      license: { allowedModes: ['INSPIRE'], licenseExpires: null },
    });
    const guide = await loadReferenceGuide(db, project({ referenceMode: 'INSPIRE' as never }), NOW);
    expect(guide?.mode).toBe('INSPIRE');
    expect(guide?.blueprint).toBeNull();
    expect(guide?.ideationSupplement).toContain('medium pacing');
    expect(guide?.scriptSupplement(10, [])).toBe(guide?.ideationSupplement);
    const plan = { fullText: 'x', shots: [] };
    expect(guide?.apply(plan as never, 10)).toBe(plan);
    expect(guide?.presetForShot(0)).toBeNull();
  });

  it('builds a TEMPLATE guide: script supplement, enforcing apply, and per-shot preset mapping', async () => {
    const { db } = fakeDb({
      id: 'lib-1',
      analysis,
      license: { allowedModes: ['TEMPLATE'], licenseExpires: null },
    });
    const guide = await loadReferenceGuide(db, project(), NOW);
    expect(guide?.mode).toBe('TEMPLATE');
    expect(guide?.ideationSupplement).toBeNull();
    expect(guide?.blueprint?.shotCount).toBe(2);
    const supplement = guide?.scriptSupplement(5, ['TEXT_CARD']);
    expect(supplement).toContain('STRUCTURE TEMPLATE');
    expect(supplement).toContain('Exactly 2 shots');

    const plan = {
      fullText: 'x',
      shots: [
        {
          sortOrder: 0,
          durationSec: 1,
          visualTreatment: 'TEXT_CARD',
          sceneDescription: 'a',
          cameraDirection: null,
          voiceoverText: null,
          onScreenText: null,
          transitionOut: 'cut',
        },
        {
          sortOrder: 1,
          durationSec: 1,
          visualTreatment: 'TEXT_CARD',
          sceneDescription: 'b',
          cameraDirection: null,
          voiceoverText: null,
          onScreenText: null,
          transitionOut: 'cut',
        },
      ],
    };
    const applied = guide?.apply(plan as never, 5);
    expect(applied?.shots).toHaveLength(2);
    expect(applied?.shots.every((s) => typeof s.durationSec === 'number')).toBe(true);
    expect(applied?.shots.every((s) => s.transitionOut === 'cut')).toBe(true);

    // Shot 0 overlayStyle 'bold-centre' → hook_bold_centre preset; shot 1 'none' → null.
    expect(guide?.presetForShot(0)).toBe('hook_bold_centre');
    expect(guide?.presetForShot(1)).toBeNull();
    expect(guide?.presetForShot(99)).toBeNull();
  });

  it('re-checks the licence at load time: expired licence throws ConflictError even for INSPIRE', async () => {
    const { db } = fakeDb({
      id: 'lib-1',
      analysis,
      license: { allowedModes: ['INSPIRE'], licenseExpires: new Date(NOW - 1000) },
    });
    await expect(
      loadReferenceGuide(db, project({ referenceMode: 'INSPIRE' as never }), NOW),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('throws ConflictError for a SCRAPED-licensed item requesting TEMPLATE mode', async () => {
    const { db } = fakeDb({
      id: 'lib-1',
      analysis,
      license: { allowedModes: ['INSPIRE'], licenseExpires: null }, // SCRAPED items only ever allow INSPIRE
    });
    await expect(
      loadReferenceGuide(db, project({ referenceMode: 'TEMPLATE' as never }), NOW),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
