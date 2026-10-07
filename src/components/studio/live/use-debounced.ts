'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * 24.2: a stable function that runs `fn` once, `delayMs` after the last call (a burst of live
 * events refreshes a screen once). The latest `fn` is used; the timer is cleared on unmount.
 */
export function useDebounced(fn: () => void, delayMs: number): () => void {
  const fnRef = useRef(fn);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => fnRef.current(), delayMs);
  }, [delayMs]);
}
