// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { exitSign, keyOutcome, swipeOutcome, swipeProgress, tiltFor } from './blitz-model';
import { SwipeDeck } from './swipe-deck';

// 22.4: the swipe deck — pointer drags, buttons, keyboard, ARIA, reduced motion and RTL.

// jsdom has no PointerEvent: a MouseEvent with a pointerId is what the deck reads.
if (typeof window !== 'undefined' && !('PointerEvent' in window)) {
  class PointerEventStub extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventStub, writable: true });
}

const items = [
  { id: 'a', label: 'Carousel: First' },
  { id: 'b', label: 'Slideshow: Second' },
  { id: 'c', label: 'AI video: Third' },
];

function setup(extra: Partial<Parameters<typeof SwipeDeck>[0]> = {}, locale?: 'ar') {
  const onKeep = vi.fn();
  const onSkip = vi.fn();
  const onEdit = vi.fn();
  const ui = (
    <SwipeDeck
      items={items}
      renderCard={(item) => <p>{item.label}</p>}
      onKeep={onKeep}
      onSkip={onSkip}
      onEdit={onEdit}
      {...extra}
    />
  );
  render(locale ? withLocale(locale, ui) : ui);
  return { onKeep, onSkip, onEdit };
}

function drag(dx: number) {
  const card = screen.getByTestId('blitz-top-card');
  fireEvent.pointerDown(card, { pointerId: 1, clientX: 200, clientY: 300, button: 0 });
  fireEvent.pointerMove(card, { pointerId: 1, clientX: 200 + dx, clientY: 310 });
  fireEvent.pointerUp(card, { pointerId: 1, clientX: 200 + dx, clientY: 310 });
}

describe('swipe helpers', () => {
  it('keeps towards the end of the line and mirrors in RTL', () => {
    expect(swipeOutcome(150, 'ltr')).toBe('keep');
    expect(swipeOutcome(-150, 'ltr')).toBe('skip');
    expect(swipeOutcome(60, 'ltr')).toBeNull();
    expect(swipeOutcome(-150, 'rtl')).toBe('keep');
    expect(swipeOutcome(150, 'rtl')).toBe('skip');
    expect(keyOutcome('ArrowRight', 'ltr')).toBe('keep');
    expect(keyOutcome('ArrowLeft', 'rtl')).toBe('keep');
    expect(keyOutcome('ArrowUp', 'rtl')).toBe('edit');
    expect(keyOutcome('Enter', 'ltr')).toBeNull();
    expect(exitSign('keep', 'ltr')).toBe(1);
    expect(exitSign('keep', 'rtl')).toBe(-1);
  });

  it('tilts with the drag (capped) and fades the stamp in', () => {
    expect(tiltFor(100)).toBe(6);
    expect(tiltFor(-10_000)).toBe(-18);
    expect(swipeProgress(55)).toBe(0.5);
    expect(swipeProgress(500)).toBe(1);
  });
});

describe('SwipeDeck', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows one card on top with the next ones behind it, labelled for screen readers', () => {
    setup();
    const deck = screen.getByRole('group', { name: 'Carousel: First' });
    expect(deck).toHaveAttribute('aria-roledescription', 'card deck');
    expect(screen.getByTestId('blitz-top-card')).toHaveTextContent('Carousel: First');
    expect(screen.getByRole('button', { name: 'Keep this post' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Skip this post' })).toBeEnabled();
  });

  it('a drag past the threshold keeps or skips; a short drag springs back', () => {
    const { onKeep, onSkip } = setup();
    drag(40);
    act(() => vi.runAllTimers());
    expect(onKeep).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
    drag(180);
    act(() => vi.runAllTimers());
    expect(onKeep).toHaveBeenCalledWith(items[0]);
  });

  it('a drag to the start skips', () => {
    const { onSkip } = setup();
    drag(-180);
    act(() => vi.runAllTimers());
    expect(onSkip).toHaveBeenCalledWith(items[0]);
  });

  it('arrow keys keep, skip and edit', () => {
    const { onKeep, onSkip, onEdit } = setup();
    const deck = screen.getByRole('group', { name: 'Carousel: First' });
    fireEvent.keyDown(deck, { key: 'ArrowUp' });
    expect(onEdit).toHaveBeenCalledWith(items[0]);
    fireEvent.keyDown(deck, { key: 'ArrowLeft' });
    act(() => vi.runAllTimers());
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onKeep).not.toHaveBeenCalled();
  });

  it('buttons work and are disabled while busy', () => {
    const { onKeep } = setup({ busy: true });
    expect(screen.getByRole('button', { name: 'Keep this post' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep this post' }));
    act(() => vi.runAllTimers());
    expect(onKeep).not.toHaveBeenCalled();
  });

  it('mirrors in Arabic: dragging to the left keeps, the → key skips', () => {
    const { onKeep, onSkip } = setup({}, 'ar');
    drag(-180);
    act(() => vi.runAllTimers());
    expect(onKeep).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('group', { name: 'Carousel: First' }), {
      key: 'ArrowRight',
    });
    act(() => vi.runAllTimers());
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
