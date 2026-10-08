// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CreateSource } from './body';
import { FormatRail } from './format-rail';

function Controlled({ onChange = vi.fn() }: { onChange?: (s: CreateSource) => void }) {
  const [value, setValue] = useState<CreateSource>('BRIEF');
  return (
    <FormatRail
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe('FormatRail (25.7)', () => {
  it('is a labelled radiogroup of the seven formats, each with its one line', () => {
    render(<FormatRail value="SLIDESHOW" onChange={vi.fn()} />);
    const group = screen.getByRole('radiogroup', { name: 'What to make' });
    const radios = screen.getAllByRole('radio');
    expect(group).toContainElement(radios[0] ?? null);
    expect(radios.map((r) => r.textContent && r.getAttribute('aria-checked'))).toHaveLength(7);
    expect(screen.getByRole('radio', { name: 'Slideshow' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'AI video' })).toHaveAccessibleDescription(
      'Scripted, shot and voiced for you',
    );
    for (const name of [
      'Carousel',
      'Your video',
      'Creator video (UGC)',
      'Hook + demo',
      'Wall of text',
    ])
      expect(screen.getByRole('radio', { name })).toHaveAttribute('aria-checked', 'false');
  });

  it('has one tab stop (the chosen format) and selects with the arrow keys', async () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const video = screen.getByRole('radio', { name: 'AI video' });
    expect(video).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Slideshow' })).toHaveAttribute('tabindex', '-1');
    video.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('SLIDESHOW');
    expect(screen.getByRole('radio', { name: 'Slideshow' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('WALL_OF_TEXT');
    await userEvent.click(screen.getByRole('radio', { name: 'Carousel' }));
    expect(onChange).toHaveBeenLastCalledWith('CAROUSEL');
  });

  it('describes the group with a note when one is given', () => {
    render(<FormatRail value="SLIDESHOW" onChange={vi.fn()} note="Why Slideshow" />);
    expect(screen.getByRole('radiogroup')).toHaveAccessibleDescription('Why Slideshow');
  });
});
