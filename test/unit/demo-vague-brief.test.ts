// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../demo/api/handlers/index';
import { handle } from '../../demo/api/registry';

// 20.18 — the demo mirrors live: a one-word brief is not turned into a rendered video; the project
// rests in DRAFT with the "too vague" reason and three directions, and choosing one runs it.

interface ProjectView {
  id: string;
  state: string;
  errorReason: string | null;
  directionOptions: string[];
  scripts: unknown[];
}

async function api(path: string, method = 'GET', body?: unknown) {
  // The registry sleeps 120-500 ms per request; fake timers need to be pushed past it.
  const pending = handle(new URL(`https://studio.demo/api/studio${path}`), {
    method,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  await vi.advanceTimersByTimeAsync(600);
  const res = await pending;
  return { status: res.status, json: (await res.json()) as { project: ProjectView } };
}

async function createProject(brief: string): Promise<string> {
  const created = await api('/projects', 'POST', {
    name: 'Vague test',
    sourceType: 'BRIEF',
    brief: { rawInput: brief },
    targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
  });
  expect(created.status).toBe(201);
  return created.json.project.id;
}

describe('demo: vague brief (20.18)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stops a one-word brief in DRAFT with the reason and three directions', async () => {
    const id = await createProject('video');
    expect((await api(`/projects/${id}/generate`, 'POST', {})).status).toBe(202);
    await vi.advanceTimersByTimeAsync(4000);
    const { project } = (await api(`/projects/${id}`)).json;
    expect(project.state).toBe('DRAFT');
    expect(project.errorReason).toBe('brief_too_vague: choose one of the suggested directions');
    expect(project.directionOptions).toHaveLength(3);
    expect(project.scripts).toHaveLength(0);
  });

  it('runs the full pipeline once a direction is chosen, and never asks twice', async () => {
    const id = await createProject('video');
    await api(`/projects/${id}/generate`, 'POST', {});
    await vi.advanceTimersByTimeAsync(4000);
    const options = (await api(`/projects/${id}`)).json.project.directionOptions as string[];
    await api(`/projects/${id}/generate`, 'POST', { rawInput: options[0], directionChosen: true });
    await vi.advanceTimersByTimeAsync(40_000);
    const { project } = (await api(`/projects/${id}`)).json;
    expect(project.state).toBe('READY_FOR_REVIEW');
    expect(project.directionOptions).toEqual([]);
  });

  it('lets a specific brief straight through', async () => {
    const id = await createProject(
      'A 15 second reel about our new sourdough range for Leeds shoppers',
    );
    await api(`/projects/${id}/generate`, 'POST', {});
    await vi.advanceTimersByTimeAsync(40_000);
    expect((await api(`/projects/${id}`)).json.project.state).toBe('READY_FOR_REVIEW');
  });
});
