import { describe, expect, it, vi } from 'vitest';
import { parseFailure } from '../../client/failure-reasons';
import { renderIdFor } from '../automation/outbox';
import { defaultProjectBudgetPence, DEFAULT_CAROUSEL_BUDGET_PENCE } from '../cost/project-budget';
import { createProjectInput } from '../services/projects';
import { projectBodyFor } from '../services/content-plan-run';
import { featureForProjectSource } from '../services/features';
import { allowanceQuartersOf } from '../ugc/allowance';
import {
  DEFAULT_TIER_QUOTAS,
  monthlyQuarterUsage,
  videoKind,
  videoLimitViolations,
} from '../services/plan-quotas';
import { monthWindow } from '../services/tier-gates';
import { CAROUSEL_ALLOWANCE_QUARTERS } from './constants';
import { CAROUSEL_TARGET_FORMATS } from './publishing';

// 21.6: where carousels plug into existing Studio services.

const carouselProject = {
  sourceType: 'CAROUSEL',
  targetFormats: CAROUSEL_TARGET_FORMATS.map((f) => ({
    platform: f.platform,
    aspectRatio: f.aspectRatio,
    duration: f.durationSec,
  })),
};

describe('allowance', () => {
  it('counts a carousel as a quarter of a short video (23.3)', async () => {
    expect(CAROUSEL_ALLOWANCE_QUARTERS).toBe(1);
    expect(allowanceQuartersOf({ metadata: { carousel: { version: 1 } } })).toBe(
      CAROUSEL_ALLOWANCE_QUARTERS,
    );
    expect(allowanceQuartersOf({ metadata: {} })).toBe(4);
    expect(videoKind(carouselProject, DEFAULT_TIER_QUOTAS.BASIC)).toBe('short');
    const now = Date.parse('2026-10-04T12:00:00Z');
    const month = monthWindow(now);
    const db = {
      videoProject: {
        findMany: vi.fn(async () => [
          {
            ...carouselProject,
            metadata: { carousel: { version: 1 }, generationStart: { at: '2026-10-02T09:00:00Z' } },
          },
          {
            sourceType: 'BRIEF',
            targetFormats: [{ platform: 'tiktok', duration: 15 }],
            metadata: { generationStart: { at: '2026-10-03T09:00:00Z' } },
          },
        ]),
      },
    };
    await expect(
      monthlyQuarterUsage(db as never, 'org_1', DEFAULT_TIER_QUOTAS.BASIC, month),
    ).resolves.toEqual({ short: 5, long: 0 }); // a carousel (1 quarter) + a video (4 quarters)
  });

  it('counts only the networks a carousel is published to against the Basic platform rule', () => {
    const quota = { ...DEFAULT_TIER_QUOTAS.BASIC, platforms: 'tiktok_instagram_plus_one' as const };
    expect(videoLimitViolations(carouselProject, quota, 'BASIC')).toEqual([]);
    expect(
      videoLimitViolations(carouselProject, quota, 'BASIC', [
        'linkedin_video',
        'facebook_feed',
      ]).map((v) => v.code),
    ).toEqual(['platforms']);
  });

  it('gives a carousel the slideshow-sized default budget', () => {
    expect(defaultProjectBudgetPence([], 'CAROUSEL', 'PLUS')).toBe(DEFAULT_CAROUSEL_BUDGET_PENCE);
  });
});

describe('projects and features', () => {
  it('needs carousel options and a brief or a pasted thread', () => {
    const base = { businessId: 'biz_1', sourceType: 'CAROUSEL' };
    expect(createProjectInput.safeParse(base).success).toBe(false);
    expect(createProjectInput.safeParse({ ...base, carousel: {} }).success).toBe(false);
    expect(
      createProjectInput.safeParse({ ...base, carousel: { thread: 'A\n---\nB' } }).success,
    ).toBe(true);
    expect(
      createProjectInput.safeParse({ ...base, carousel: {}, brief: { rawInput: 'Tips' } }).success,
    ).toBe(true);
  });

  it('puts carousels behind their own feature switch', () => {
    expect(featureForProjectSource('CAROUSEL')).toBe('carousels');
  });
});

describe('auto-publish outbox', () => {
  it('sends a carousel network to the run’s carousel render', () => {
    const metadata = { renders: { s1: 'r_car' } };
    const renders = [
      { id: 'r_old', targetPlatform: 'carousel' },
      { id: 'r_car', targetPlatform: 'carousel' },
    ];
    expect(renderIdFor(metadata, renders, 'instagram_feed')).toBe('r_car');
    expect(renderIdFor(metadata, renders, 'tiktok')).toBe('r_car');
    expect(renderIdFor(metadata, renders, 'youtube')).toBeUndefined();
  });
});

describe('month plans', () => {
  it('turns a CAROUSEL item into a carousel project going only to carousel networks', () => {
    const body = projectBodyFor(
      {
        businessId: 'biz_1',
        platforms: ['tiktok', 'youtube_short'],
        language: 'de',
        brandKitId: null,
        metadata: null,
        targets: [
          { platform: 'tiktok', connectionId: 'c1' },
          { platform: 'youtube_short', connectionId: 'c2' },
        ],
      },
      {
        kind: 'CAROUSEL',
        angle: 'how_to',
        title: 'Bread tips',
        brief: 'Five ways to keep bread fresh',
        slides: null,
        slotAt: new Date('2026-10-10T09:00:00Z'),
      },
      30,
    );
    expect(body).toMatchObject({
      sourceType: 'CAROUSEL',
      carousel: { theme: 'light', postCount: 7 },
      brief: { rawInput: 'Bread tips\n\nFive ways to keep bread fresh' },
      autoPublish: { targets: [{ platform: 'tiktok', connectionId: 'c1' }] },
    });
    expect(body).not.toHaveProperty('targetFormats');
    expect(createProjectInput.safeParse(body).success).toBe(true);
  });
});

describe('failure reasons', () => {
  it('reads the carousel codes and the quality gate’s check list', () => {
    expect(parseFailure('carousel_incomplete: no posts')).toMatchObject({
      code: 'carousel_incomplete',
      detail: null,
    });
    expect(parseFailure('carousel_render_error: disk full')?.code).toBe('carousel_render_error');
    expect(
      parseFailure(
        'quality_failed: carousel/low_contrast: slide 2; carousel/image_stretched: slide 3',
      )?.params,
    ).toEqual({
      checks: [
        { platform: 'carousel', check: 'low_contrast' },
        { platform: 'carousel', check: 'image_stretched' },
      ],
    });
  });
});
