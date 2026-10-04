import { describe, expect, it } from 'vitest';
import { respellToScript } from './script-spelling';

const w = (text: string, startSec: number, endSec: number) => ({ text, startSec, endSec });

describe('respellToScript (production QA run 11, 2026-10-04)', () => {
  it('restores a brand name the transcript split into words, keeping its timing', () => {
    const words = [
      w("That's", 0.1, 0.3),
      w('where', 0.3, 0.5),
      w('a', 0.5, 0.55),
      w('head', 0.55, 0.8),
      w('AI', 0.8, 1.1),
      w('steps', 1.1, 1.4),
      w('in.', 1.4, 1.7),
    ];
    const out = respellToScript(words, "That's where AheadAI steps in.");
    expect(out.map((x) => x.text)).toEqual(["That's", 'where', 'AheadAI', 'steps', 'in.']);
    expect(out[2]).toEqual({ text: 'AheadAI', startSec: 0.5, endSec: 1.1 });
  });

  it('uses the script spelling and punctuation for matching words', () => {
    const out = respellToScript([w('meet', 0, 0.3), w('aheadai', 0.3, 0.9)], 'Meet AheadAi.');
    expect(out.map((x) => x.text)).toEqual(['Meet', 'AheadAi.']);
  });

  it('splits one spoken token across script words by letters', () => {
    const out = respellToScript([w('AheadAI', 0, 1.4)], 'Ahead AI');
    expect(out.map((x) => x.text)).toEqual(['Ahead', 'AI']);
    expect(out[0]!.startSec).toBe(0);
    expect(out[1]!.endSec).toBe(1.4);
    expect(out[0]!.endSec).toBeCloseTo(1.0, 3);
  });

  it('leaves the transcript alone when it does not line up (misheard or "2" read as "two")', () => {
    const words = [w('two', 0, 0.3), w('minutes', 0.3, 0.8)];
    expect(respellToScript(words, '2 minutes')).toBe(words);
    const misheard = [w('bread', 0, 0.4), w('daily', 0.4, 0.8)];
    expect(respellToScript(misheard, 'Fresh bread daily')).toBe(misheard);
  });

  it('allows the script to run past a trimmed narration', () => {
    const out = respellToScript([w('hours', 0, 0.3), w('to', 0.3, 0.4)], 'hours to prep.');
    expect(out.map((x) => x.text)).toEqual(['hours', 'to']);
  });

  it('returns the transcript when there is no script text', () => {
    const words = [w('hello', 0, 0.3)];
    expect(respellToScript(words, null)).toBe(words);
  });
});
