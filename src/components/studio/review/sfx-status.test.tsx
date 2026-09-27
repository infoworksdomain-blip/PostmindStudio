// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readSfx, SfxStatus } from './sfx-status';
import { makeProject } from './test-helpers';

describe('readSfx', () => {
  it('reads each status and the per-cue results', () => {
    expect(
      readSfx({
        sfx: {
          status: 'added',
          cues: [
            { cue: 'whoosh', status: 'added', title: 'Fast Whoosh', shotIds: ['a', 'b'] },
            { cue: 'gong', status: 'no_match', shotIds: ['c'] },
            { cue: 42, status: 'added' },
          ],
        },
      }),
    ).toEqual({
      status: 'added',
      cues: [
        { cue: 'whoosh', status: 'added', title: 'Fast Whoosh', shots: 2 },
        { cue: 'gong', status: 'no_match', title: null, shots: 1 },
      ],
    });
    expect(readSfx({ sfx: { status: 'off_for_plan' } })).toEqual({ status: 'off_for_plan' });
    expect(readSfx({ sfx: { status: 'unavailable', reason: 'no key' } })).toEqual({
      status: 'unavailable',
      reason: 'no key',
    });
    expect(readSfx({ sfx: { status: 'failed', cues: 'x' } })).toEqual({
      status: 'failed',
      cues: [],
    });
    expect(readSfx({ sfx: { status: 'none', cues: [] } })).toBeNull();
    expect(readSfx({})).toBeNull();
    expect(readSfx(null)).toBeNull();
  });
});

describe('SfxStatus', () => {
  it('lists the cues that were added and the ones that were not', () => {
    render(
      <SfxStatus
        project={makeProject({
          metadata: {
            sfx: {
              status: 'added',
              cues: [
                { cue: 'whoosh', status: 'added', title: 'Fast Whoosh', shotIds: ['a', 'b'] },
                { cue: 'gong', status: 'no_match', shotIds: ['c'] },
              ],
            },
          },
        })}
      />,
    );
    const panel = screen.getByLabelText('Sound effects');
    expect(panel).toHaveTextContent('Sound effects: 1 of 2 added.');
    expect(panel).toHaveTextContent('“whoosh” → Fast Whoosh · added · 2 shots');
    expect(panel).toHaveTextContent('“gong” · no matching effect');
  });

  it('explains when effects are off or not set up', () => {
    const { rerender } = render(
      <SfxStatus project={makeProject({ metadata: { sfx: { status: 'off_for_plan' } } })} />,
    );
    expect(screen.getByLabelText('Sound effects')).toHaveTextContent(
      'No sound effects on this plan.',
    );
    rerender(<SfxStatus project={makeProject({ metadata: { sfx: { status: 'unavailable' } } })} />);
    expect(screen.getByLabelText('Sound effects')).toHaveTextContent('not set up yet');
    rerender(
      <SfxStatus project={makeProject({ metadata: { sfx: { status: 'failed', cues: [] } } })} />,
    );
    expect(screen.getByLabelText('Sound effects')).toHaveTextContent('could not be added');
  });

  it('renders nothing when the script asked for no effects', () => {
    const { container } = render(
      <SfxStatus project={makeProject({ metadata: { sfx: { status: 'none', cues: [] } } })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
