// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../demo/api/handlers/index';
import { handle } from '../../demo/api/registry';
import { DEMO_BUSINESS_ID } from '../../demo/api/ids';

// 22.1 / 22.2 — the demo mirrors live: the demo-video bank, hook + demo projects (two shots, the
// hook line on the hook), wall-of-text projects (one shot with the text block), and a seeded
// sample of each ready for review.

interface Shot {
  visualTreatment: string;
  durationSec: number;
  onScreenText: string | null;
}
interface ProjectView {
  id: string;
  state: string;
  sourceType: string;
  scripts: Array<{ shots: Shot[] }>;
  metadata: Record<string, unknown>;
}

async function api(path: string, method = 'GET', body?: unknown) {
  const pending = handle(new URL(`https://studio.demo/api/studio${path}`), {
    method,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  await vi.advanceTimersByTimeAsync(600);
  const res = await pending;
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const tiktok = [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 }];

async function scripts(id: string): Promise<Array<{ shots: Shot[] }>> {
  return (await api(`/projects/${id}/scripts`)).json.data as Array<{ shots: Shot[] }>;
}

describe('demo: Fastlane-style formats (22.1 / 22.2)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lists the seeded demo video in the bank', async () => {
    const res = await api(`/uploads/demo-videos?businessId=${DEMO_BUSINESS_ID}`);
    const data = res.json.data as Array<{ id: string; fileName: string }>;
    expect(data[0]).toMatchObject({ fileName: 'order-ahead-app-demo.mp4' });
  });

  it('a hook + demo project plans a 3 s hook with the line, then the demo', async () => {
    const created = await api('/projects', 'POST', {
      sourceType: 'HOOK_DEMO',
      businessId: DEMO_BUSINESS_ID,
      targetFormats: tiktok,
      hookDemo: { hookLine: 'Coffee, ordered before you leave' },
    });
    expect(created.status).toBe(201);
    const id = (created.json.project as ProjectView).id;
    await api(`/projects/${id}/generate`, 'POST', {});
    await vi.advanceTimersByTimeAsync(40_000);
    const project = (await api(`/projects/${id}`)).json.project as ProjectView;
    expect(project.state).toBe('READY_FOR_REVIEW');
    const shots = (await scripts(id))[0]?.shots ?? [];
    expect(shots.map((s) => [s.visualTreatment, s.durationSec])).toEqual([
      ['AI_CLIP', 3],
      ['USER_UPLOAD', 12],
    ]);
    expect(shots[0]?.onScreenText).toBe('Coffee, ordered before you leave');
    expect(shots[1]?.onScreenText).toBeNull();
  });

  it('refuses a hook + demo video for a business without demo videos (no_demo_video)', async () => {
    const res = await api('/projects', 'POST', {
      sourceType: 'HOOK_DEMO',
      businessId: 'biz_without_demos',
      targetFormats: tiktok,
    });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ error: 'no_demo_video' });
  });

  it('a wall of text plans one shot carrying the whole block', async () => {
    const created = await api('/projects', 'POST', {
      sourceType: 'WALL_OF_TEXT',
      businessId: DEMO_BUSINESS_ID,
      targetFormats: tiktok,
      wallOfText: { text: 'Three habits\n- Plan\n- Rest', durationSec: 10 },
    });
    const id = (created.json.project as ProjectView).id;
    await api(`/projects/${id}/generate`, 'POST', {});
    await vi.advanceTimersByTimeAsync(40_000);
    const project = (await api(`/projects/${id}`)).json.project as ProjectView;
    expect(project.state).toBe('READY_FOR_REVIEW');
    expect((await scripts(id))[0]?.shots).toMatchObject([
      {
        visualTreatment: 'STOCK_FOOTAGE',
        durationSec: 10,
        onScreenText: 'Three habits\n- Plan\n- Rest',
      },
    ]);
  });

  it('seeds one sample of each format, ready for review', async () => {
    for (const id of ['prj-hook-demo-order-ahead', 'prj-wall-bread-tips']) {
      const project = (await api(`/projects/${id}`)).json.project as ProjectView;
      expect(project.state).toBe('READY_FOR_REVIEW');
      expect(['HOOK_DEMO', 'WALL_OF_TEXT']).toContain(project.sourceType);
    }
  });
});
