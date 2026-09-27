import { describe, expect, it } from 'vitest';
import { previewRange } from './preview';

// BACKLOG 8.7 — previewRange edge cases only (previewOverlay's DB/provider orchestration is
// covered at the integration/service layer, not here).

describe('previewRange', () => {
  it('leads in half a second before the overlay start when there is room', () => {
    expect(previewRange(10, 5)).toEqual({ start: 4.5, length: 3 });
  });

  it('clamps length to the shot duration for a short shot', () => {
    expect(previewRange(2, 0.5)).toEqual({ start: 0, length: 2 });
  });

  it('clamps start to 0 when the overlay starts before the lead-in fits', () => {
    expect(previewRange(10, 0.2)).toEqual({ start: 0, length: 3 });
  });

  it('clamps start to 0 when the overlay starts exactly at time 0', () => {
    expect(previewRange(10, 0)).toEqual({ start: 0, length: 3 });
  });

  it('pulls the window back when the overlay is near the end of the shot', () => {
    expect(previewRange(10, 9.5)).toEqual({ start: 7, length: 3 });
  });

  it('starts at 0 for a shot shorter than the preview window with a late overlay start', () => {
    expect(previewRange(1, 0.9)).toEqual({ start: 0, length: 1 });
  });

  it('handles a zero-length shot', () => {
    expect(previewRange(0, 0)).toEqual({ start: 0, length: 0 });
  });

  it('rounds start and length to 3 decimal places', () => {
    const result = previewRange(10.123456, 5.123456);
    expect(result.start).toBe(4.623);
    expect(result.length).toBe(3);
  });
});
