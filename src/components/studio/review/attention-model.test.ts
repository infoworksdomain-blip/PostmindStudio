import { describe, expect, it } from 'vitest';
import { attentionItems } from './attention-model';
import { makeProject } from './test-helpers';

// BACKLOG 25.8 — every notice that used to stack above the tabs becomes one row, exactly when its
// panel would have shown, ordered: things to do, then warnings, then good-to-know.

const NOW = Date.parse('2026-10-07T12:00:00Z');
const keys = (...args: Parameters<typeof attentionItems>) =>
  attentionItems(args[0], { now: NOW, ...args[1] }).map((i) => i.key);

describe('attentionItems', () => {
  it('is empty for a clean project ready for review', () => {
    expect(keys(makeProject())).toEqual([]);
  });

  it('asks for a direction when the brief was too vague', () => {
    const items = attentionItems(
      makeProject({ state: 'DRAFT', errorReason: 'brief_too_vague', renders: [] }),
      { now: NOW },
    );
    expect(items).toEqual([{ key: 'directions', tone: 'action' }]);
  });

  it('collects a failure with its pause and the warnings and notes of the run, in tone order', () => {
    const project = makeProject({
      state: 'FAILED',
      errorReason: 'cost_cap_paused: org_daily',
      metadata: {
        costPause: { scope: 'org_daily' },
        music: { status: 'failed', reason: 'provider down' },
        sfx: { status: 'failed', cues: [] },
        fallbacks: [{ layer: 'voice', usedProviderId: 'azure', skipped: [] }],
        degradedShots: [
          { shotId: 'shot_1', degradedFrom: 'avatar_video' },
          { shotId: 'shot_2', degradedFrom: 'actor_video' },
        ],
        safetyReview: { state: 'PENDING' },
      },
    });
    expect(keys(project)).toEqual([
      'failure',
      'autoResume',
      'safetyReview',
      'music',
      'sfx',
      'fallback',
      'presenterFallback',
      'actorFallback',
    ]);
  });

  it('notes a run waiting for a busy provider only while the wait is fresh', () => {
    const waiting = (retryAt: string) =>
      makeProject({ state: 'ASSETS_GENERATING', metadata: { providerWait: { retryAt } } });
    expect(keys(waiting('2026-10-07T11:59:00Z'))).toEqual(['queued']);
    expect(keys(waiting('2026-10-07T11:00:00Z'))).toEqual([]);
  });

  it('flags automatic review that needs a person, and a project budget pause (not for carousels)', () => {
    const review = makeProject({
      metadata: { review: { decision: 'needs_review', reasons: ['enterprise_plan'] } },
    });
    expect(keys(review)).toEqual(['automation']);
    const budget = makeProject({ state: 'FAILED', errorReason: 'cost_cap_paused: project' });
    expect(keys(budget)).toEqual(['failure', 'budget']);
    expect(keys({ ...budget, sourceType: 'CAROUSEL' }, { isCarousel: true })).toEqual(['failure']);
  });

  it('does not flag music or sound effects that worked', () => {
    const project = makeProject({
      metadata: { music: { status: 'generated' }, sfx: { status: 'added', cues: [] } },
    });
    expect(keys(project)).toEqual([]);
  });
});
