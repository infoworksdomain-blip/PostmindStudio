// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MusicStatus, readMusic } from './music-status';
import { makeProject } from './test-helpers';

describe('readMusic', () => {
  it('reads each recorded status and ignores anything else', () => {
    expect(readMusic({ music: { status: 'generated', durationSec: 15, reused: true } })).toEqual({
      status: 'generated',
      durationSec: 15,
      reused: true,
    });
    expect(readMusic({ music: { status: 'off_for_plan' } })).toEqual({ status: 'off_for_plan' });
    expect(readMusic({ music: { status: 'failed', reason: 'x' } })).toEqual({
      status: 'failed',
      reason: 'x',
    });
    expect(readMusic({ music: { skipped: 'no music provider configured' } })).toEqual({
      status: 'none',
    });
    expect(readMusic({ music: { status: 'weird' } })).toBeNull();
    expect(readMusic(null)).toBeNull();
    expect(readMusic({})).toBeNull();
  });
});

describe('MusicStatus', () => {
  it('says the track was generated', () => {
    render(
      <MusicStatus
        project={makeProject({ metadata: { music: { status: 'generated', durationSec: 15 } } })}
      />,
    );
    expect(screen.getByLabelText('Music')).toHaveTextContent(
      'Background music generated (15 s track).',
    );
  });

  it('says music is off for the plan', () => {
    render(
      <MusicStatus project={makeProject({ metadata: { music: { status: 'off_for_plan' } } })} />,
    );
    expect(screen.getByLabelText('Music')).toHaveTextContent('No background music on this plan');
  });

  it('explains a failure without hiding the video', () => {
    render(
      <MusicStatus
        project={makeProject({
          metadata: { music: { status: 'failed', reason: 'elevenlabs-music content_policy' } },
        })}
      />,
    );
    const status = screen.getByLabelText('Music');
    expect(status).toHaveTextContent('narration only');
    expect(status).toHaveTextContent('elevenlabs-music content_policy');
  });

  it('renders nothing when the run has no music record', () => {
    const { container } = render(<MusicStatus project={makeProject({ metadata: null })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
