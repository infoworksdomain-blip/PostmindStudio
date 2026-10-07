// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyIllustration, type IllustrationName } from './empty-illustration';
import { EmptyState } from './primitives';

// BACKLOG 20.8 — empty states show an original line drawing instead of a generic icon. The
// drawing is decorative: hidden from assistive technology, the title says what is missing.

const NAMES: IllustrationName[] = [
  'projects',
  'publications',
  'library',
  'images',
  'brand',
  'voice',
  'connections',
  'business',
  'approvals',
  'templates',
  'memory',
];

describe('EmptyIllustration', () => {
  it.each(NAMES)('draws %s as a decorative, sized SVG', (name) => {
    const { container } = render(<EmptyIllustration name={name} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
    expect(svg).toHaveAttribute('data-illustration', name);
    expect(svg).toHaveAttribute('width', '160');
    expect(svg).toHaveAttribute('height', '112');
    expect(svg.querySelectorAll('path, rect, circle, ellipse').length).toBeGreaterThan(3);
  });
});

describe('EmptyState', () => {
  it('draws an illustration when media names one, and keeps the title and action', () => {
    const { container } = render(
      <EmptyState
        media="projects"
        title="No videos yet"
        description="Make your first one."
        action={<button type="button">New video</button>}
      />,
    );
    expect(container.querySelector('[data-illustration="projects"]')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'No videos yet' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'New video' })).toBeVisible();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('still shows the icon when no illustration is given', () => {
    render(<EmptyState media={<span data-testid="icon" />} title="Nothing here" />);
    expect(screen.getByTestId('icon')).toBeTruthy();
  });
});
