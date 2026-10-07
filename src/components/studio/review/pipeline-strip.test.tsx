// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { failedStepOf, pipelineView } from './pipeline-model';
import { PipelineStrip, stepIndex } from './pipeline-strip';
import { makeProject, makeRender } from './test-helpers';

const statuses = (project: Parameters<typeof pipelineView>[0]) =>
  pipelineView(project).steps.map((s) => s.status);

describe('PipelineStrip', () => {
  it('maps states to steps', () => {
    expect(stepIndex('DRAFT')).toBe(-1);
    expect(stepIndex('PLANNING')).toBe(1);
    expect(stepIndex('ASSETS_GENERATING')).toBe(2);
    expect(stepIndex('PUBLISHED')).toBe(6);
  });

  it('marks the current step and the finished ones', () => {
    render(<PipelineStrip project={makeProject({ state: 'RENDERING', renders: [] })} />);
    const items = screen.getAllByRole('listitem');
    expect(items[3]).toHaveAttribute('aria-current', 'step');
    expect(items[3]).toHaveAttribute('data-status', 'current');
    expect(items[0]).toHaveTextContent('(done)');
    expect(items[4]).not.toHaveTextContent('(done)');
  });

  it('shows every step done once published', () => {
    render(<PipelineStrip project={makeProject({ state: 'PUBLISHED' })} />);
    expect(screen.getAllByText('(done)')).toHaveLength(7);
  });

  it('says a draft has not started yet', () => {
    render(<PipelineStrip project={makeProject({ state: 'DRAFT', renders: [], scripts: [] })} />);
    expect(screen.getByText('Not started — Generate to begin.')).toBeInTheDocument();
    expect(screen.queryByText('(done)')).toBeNull();
  });

  it('shows which step a failed run stopped at', () => {
    const project = makeProject({
      state: 'FAILED',
      errorReason: 'composition_failed: shotstack said no',
      renders: [],
    });
    render(<PipelineStrip project={project} />);
    const items = screen.getAllByRole('listitem');
    expect(items[3]).toHaveAttribute('data-status', 'failed');
    expect(items[3]).toHaveTextContent('(stopped here)');
    expect(items[2]).toHaveAttribute('data-status', 'done');
    expect(items[4]).toHaveAttribute('data-status', 'todo');
    expect(screen.getByText('Stopped at the Render step.')).toBeInTheDocument();
  });

  it('flags a rejected video as waiting at review, not failed', () => {
    expect(statuses(makeProject({ state: 'REJECTED' }))).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
      'attention',
      'todo',
    ]);
  });
});

describe('failedStepOf', () => {
  it('reads the step from the failure code', () => {
    const at = (errorReason: string) =>
      failedStepOf(makeProject({ state: 'FAILED', errorReason, renders: [] }));
    expect(at('planning_failed: timeout')).toBe('script');
    expect(at('asset_generation_failed: shot_1')).toBe('shots');
    expect(at('composition_failed')).toBe('render');
    expect(at('quality_failed: black_frames')).toBe('quality');
  });

  it('falls back to how far the run got (cancelled, provider outage, unknown reason)', () => {
    const noScript = makeProject({
      state: 'FAILED',
      errorReason: 'cancelled_by_user',
      scripts: [],
    });
    expect(failedStepOf(noScript)).toBe('script');
    const base = makeProject();
    const script = base.scripts[0]!;
    const unfinished = makeProject({
      state: 'FAILED',
      errorReason: 'something new',
      renders: [],
      scripts: [{ ...script, shots: [{ ...script.shots[0]!, state: 'FAILED' }] }],
    });
    expect(failedStepOf(unfinished)).toBe('shots');
    expect(failedStepOf({ ...unfinished, scripts: base.scripts })).toBe('render');
    expect(failedStepOf({ ...unfinished, scripts: base.scripts, renders: [makeRender()] })).toBe(
      'quality',
    );
  });

  it('puts a quality failure at the quality step', () => {
    expect(statuses(makeProject({ state: 'QUALITY_FAILED', errorReason: null }))[4]).toBe('failed');
  });
});
