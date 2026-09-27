// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PipelineStrip, stepIndex } from './pipeline-strip';

describe('PipelineStrip', () => {
  it('maps states to steps', () => {
    expect(stepIndex('DRAFT')).toBe(-1);
    expect(stepIndex('PLANNING')).toBe(1);
    expect(stepIndex('ASSETS_GENERATING')).toBe(2);
    expect(stepIndex('PUBLISHED')).toBe(6);
  });

  it('marks the current step and the finished ones', () => {
    render(<PipelineStrip state="RENDERING" />);
    const items = screen.getAllByRole('listitem');
    expect(items[3]).toHaveAttribute('aria-current', 'step');
    expect(items[0]).toHaveTextContent('(done)');
    expect(items[4]).not.toHaveTextContent('(done)');
  });

  it('shows every step done once published', () => {
    render(<PipelineStrip state="PUBLISHED" />);
    expect(screen.getAllByText('(done)')).toHaveLength(7);
  });
});
