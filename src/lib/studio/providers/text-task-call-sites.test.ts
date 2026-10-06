import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEXT_TASK_TIER, type TextTask } from './text-tasks';

// 23.2 — every Claude call site names its task, so its model (Haiku for the light ones) is an
// explicit, reviewable choice. This pins which task each call site sends.

const ROOT = join(__dirname, '..');

const CALL_SITES: ReadonlyArray<[file: string, tasks: TextTask[]]> = [
  ['queue/workers/plan-project.ts', ['ideation', 'script', 'script_safety', 'post_copy']],
  ['queue/workers/regenerate-script.ts', ['script', 'script_safety']],
  ['queue/workers/format-plan-common.ts', ['script_safety']],
  ['queue/workers/plan-hook-demo.ts', ['hook_line']],
  ['queue/workers/plan-wall-of-text.ts', ['wall_text']],
  ['queue/workers/plan-upload.ts', ['script_safety']],
  ['queue/workers/plan-slideshow.ts', ['script_safety']],
  ['queue/workers/plan-carousel.ts', ['script_safety']],
  ['services/caption-suggestions.ts', ['post_copy']],
  ['services/angles.ts', ['blitz_angles']],
  ['services/blitz-refill.ts', ['blitz_cards']],
  ['services/content-plan-draft.ts', ['month_plan']],
  ['ugc/clip-text-guard.ts', ['clip_text_check']],
  ['carousel/writer.ts', ['carousel_thread']],
  ['slideshow/populate.ts', ['slideshow_text']],
  ['queue/workers/scan-website.ts', ['business_profile']],
  ['library/ingest.ts', ['library_analysis']],
];

describe('Claude call sites name their task (23.2)', () => {
  it.each(CALL_SITES)('%s sends %j', (file, tasks) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const task of tasks) expect(source).toContain(`'${task}'`);
  });

  it('the light tasks are the ones the operator listed for Haiku', () => {
    const light = Object.entries(TEXT_TASK_TIER)
      .filter(([, tier]) => tier === 'light')
      .map(([task]) => task)
      .sort();
    expect(light).toEqual(
      [
        'blitz_angles',
        'clip_text_check',
        'hook_line',
        'post_copy',
        'script_safety',
        'wall_text',
      ].sort(),
    );
  });
});
