import { describe, expect, it } from 'vitest';
import { platformState, STATE_TONE } from './connection-status';

describe('platformState (25.12)', () => {
  it('reads one state per platform from its accounts and set-up', () => {
    expect(platformState([], true)).toBe('notConnected');
    expect(platformState([], false)).toBe('unavailable');
    expect(platformState([{ state: 'active' }], true)).toBe('connected');
    expect(platformState([{ state: 'active' }, { state: 'needs_reconnect' }], true)).toBe(
      'needsReconnect',
    );
    // An account that lost access is reported even when its app is no longer set up.
    expect(platformState([{ state: 'needs_reconnect' }], false)).toBe('needsReconnect');
  });

  it('gives each state a tone', () => {
    expect(STATE_TONE).toEqual({
      connected: 'good',
      needsReconnect: 'warn',
      notConnected: 'neutral',
      unavailable: 'bad',
    });
  });
});
