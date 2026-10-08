// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../demo/api/handlers/index';
import { handle } from '../../demo/api/registry';
import { posterClipFor, samplePoster, VIDEO_POSTERS, WALL_OF_TEXT_POSTERS } from '../../demo/media';

// 25 polish — the demo's render posters are the Studio-made showcase posters
// (public/marketing/studio), not flat placeholders: GET /renders/:id, a regenerated thumbnail and
// the calendar side panel's preview (GET /projects/:id/preview). Under jsdom no image decodes, so
// samplePoster returns the poster file's URL (in the demo build it is the inlined, SAMPLE-marked
// poster).

async function api(path: string, method = 'GET', body?: unknown) {
  const pending = handle(new URL(`https://studio.demo/api/studio${path}`), {
    method,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  await vi.advanceTimersByTimeAsync(600);
  const res = await pending;
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

interface RenderRow {
  id: string;
}

async function firstRender(projectId: string): Promise<RenderRow> {
  const res = await api(`/projects/${projectId}/renders`);
  const data = (res.json.data ?? res.json.renders) as RenderRow[];
  const render = data[0];
  if (!render) throw new Error(`no render for ${projectId}`);
  return render;
}

describe('demo showcase posters', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('picks the same showcase poster for a project every time', () => {
    expect(posterClipFor('prj-a')).toBe(posterClipFor('prj-a'));
    expect(VIDEO_POSTERS).toContain(posterClipFor('prj-a'));
    expect(WALL_OF_TEXT_POSTERS).toContain(posterClipFor('prj-a', 'wall_of_text'));
    const spread = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => posterClipFor(s)));
    expect(spread.size).toBeGreaterThan(1);
  });

  it('serves a showcase poster file, never a drawn placeholder', () => {
    expect(samplePoster('prj-a')).toMatch(/^\/marketing\/studio\/.+-360\.webp$/);
    expect(samplePoster('prj-a', 'wall_of_text')).toMatch(/wall-of-text-360\.webp$/);
  });

  it('GET /renders/:id carries the project showcase poster as its thumbnail', async () => {
    const render = await firstRender('prj-wall-bread-tips');
    const res = await api(`/renders/${render.id}`);
    const url = (res.json.render as { thumbnailUrl: string }).thumbnailUrl;
    expect(url).toBe(samplePoster('prj-wall-bread-tips', 'wall_of_text'));
    expect(url).toContain('wall-of-text');
  });

  it('a regenerated thumbnail puts the overlay text over the poster', async () => {
    const render = await firstRender('prj-hook-demo-order-ahead');
    const res = await api(`/renders/${render.id}/thumbnail`, 'POST', {
      overlayText: 'Order ahead',
    });
    const url = (res.json.render as { thumbnailUrl: string }).thumbnailUrl;
    const svg = decodeURIComponent(url.split(',')[1] ?? '');
    expect(svg).toContain(`<image href="${samplePoster('prj-hook-demo-order-ahead')}"`);
    expect(svg).toContain('Order ahead');
  });

  it('GET /projects/:id/preview shows a made post with its poster for the calendar panel', async () => {
    const res = await api('/projects/prj-wall-bread-tips/preview');
    expect(res.status).toBe(200);
    const preview = res.json.preview as {
      projectId: string;
      format: string;
      media: { kind: string; slides?: Array<{ imageUrl: string }> };
      live: { thumbnailUrl: string | null };
    };
    expect(preview.projectId).toBe('prj-wall-bread-tips');
    expect(preview.format).toBe('wall_of_text');
    expect(preview.media.kind).toBe('slides');
    expect(preview.media.slides?.[0]?.imageUrl).toBe(
      samplePoster('prj-wall-bread-tips', 'wall_of_text'),
    );
    expect(preview.live.thumbnailUrl).toBe(preview.media.slides?.[0]?.imageUrl);
  });

  it('GET /projects/:id/preview answers 404 for an unknown project', async () => {
    const res = await api('/projects/prj-missing/preview');
    expect(res.status).toBe(404);
  });
});
