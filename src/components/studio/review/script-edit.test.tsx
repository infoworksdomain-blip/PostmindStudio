// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptView, scriptPatch } from './script-view';
import { makeProject, mockFetch, renderWithSWR } from './test-helpers';

// 13.1 — editable Script tab and "Regenerate script".

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const script = {
  id: 'scr_1',
  projectId: 'proj_1',
  targetPlatform: 'tiktok',
  targetAspectRatio: '9:16',
  targetDurationSec: 12,
  fullText: 'Spring is here. Three new plates.',
  scriptModel: 'claude',
  shots: [
    {
      id: 'shot_1',
      scriptId: 'scr_1',
      sortOrder: 0,
      durationSec: 5,
      visualTreatment: 'AI_CLIP',
      state: 'READY',
      errorReason: null,
      sceneDescription: 'Plates',
      cameraDirection: null,
      voiceoverText: 'Spring is here.',
      onScreenText: 'Spring',
      transitionOut: null,
      assetId: 'a1',
      voiceAssetId: 'v1',
    },
  ],
};

describe('scriptPatch', () => {
  it('sends only what changed, with null for cleared text', () => {
    const texts = { shot_1: { voiceoverText: 'Hello spring.', onScreenText: '' } };
    expect(scriptPatch(script, script.fullText, texts)).toEqual({
      shots: [{ id: 'shot_1', voiceoverText: 'Hello spring.', onScreenText: null }],
    });
    expect(
      scriptPatch(script, script.fullText, {
        shot_1: { voiceoverText: 'Spring is here.', onScreenText: 'Spring' },
      }),
    ).toBeNull();
    expect(scriptPatch(script, 'New voiceover', {})).toEqual({ fullText: 'New voiceover' });
  });
});

describe('ScriptView (13.1)', () => {
  it('edits a shot narration and saves with PATCH /scripts/:id', async () => {
    const onChanged = vi.fn();
    const api = mockFetch([
      { match: '/scripts/scr_1', body: { ok: true, script } },
      {
        method: 'PATCH',
        match: '/scripts/scr_1',
        body: {
          ok: true,
          script,
          staleRenders: ['ren_1'],
          runId: 'r2',
          voiceRegenerated: ['shot_1'],
        },
      },
    ]);
    renderWithSWR(<ScriptView project={makeProject()} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole('button', { name: /Edit script/ }));
    const narration = await screen.findByLabelText('Shot 1 narration');
    await userEvent.clear(narration);
    await userEvent.type(narration, 'Hello spring.');
    expect(screen.getByText(/re-voices 1 shot/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Save script/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.find('PATCH', '/scripts/scr_1')[0]?.body).toEqual({
      shots: [{ id: 'shot_1', voiceoverText: 'Hello spring.' }],
    });
  });

  it('regenerates the script with an instruction', async () => {
    const onChanged = vi.fn();
    const api = mockFetch([
      {
        method: 'POST',
        match: '/scripts/scr_1/regenerate',
        status: 202,
        body: { ok: true, project: { id: 'proj_1', state: 'QUEUED' }, runId: 'r3' },
      },
    ]);
    renderWithSWR(<ScriptView project={makeProject()} onChanged={onChanged} />);
    await userEvent.type(screen.getByLabelText(/Instruction for a rewrite/), 'Punchier hook');
    await userEvent.click(screen.getByRole('button', { name: /Regenerate script/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.find('POST', '/scripts/scr_1/regenerate')[0]?.body).toEqual({
      instruction: 'Punchier hook',
    });
  });

  it('is read-only while generating and never offers a rewrite for uploads', () => {
    mockFetch([]);
    const { unmount } = renderWithSWR(<ScriptView project={makeProject({ state: 'RENDERING' })} />);
    expect(screen.queryByRole('button', { name: /Edit script/ })).not.toBeInTheDocument();
    expect(screen.getByText(/can be edited once the video is ready/)).toBeInTheDocument();
    unmount();
    renderWithSWR(<ScriptView project={makeProject({ sourceType: 'UPLOAD' })} />);
    expect(screen.queryByRole('button', { name: /Regenerate script/ })).not.toBeInTheDocument();
  });
});
