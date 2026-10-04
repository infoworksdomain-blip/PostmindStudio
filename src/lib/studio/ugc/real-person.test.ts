import { describe, expect, it } from 'vitest';
import { checkRealPersonRequest } from './real-person';

describe('checkRealPersonRequest (21.4)', () => {
  it.each([
    'Make the actor look like a celebrity',
    'A famous footballer reviews our boots',
    'Have someone impersonate the Prime Minister',
    'deepfake of our CEO saying hello',
    'a lookalike of a pop star',
    'pretend to be a TV chef',
    'the voice of David Attenborough',
    'it should sound like Morgan Freeman',
    'a woman who looks like Taylor Swift',
    'a guy resembling Tom Hardy',
    'starring Idris Elba',
    'make her look exactly like me',
    'sounds like my husband',
  ])('refuses: %s', (brief) => {
    expect(checkRealPersonRequest(brief).refused).toBe(true);
  });

  it.each([
    'A friendly woman in her thirties reviews our sourdough subscription',
    'Make it look like New York at night',
    'A cosy kitchen that looks like a farmhouse',
    'Show the product in the car, it sounds quiet',
    'Our customers love the Leeds Market stall',
    '',
  ])('allows: %s', (brief) => {
    expect(checkRealPersonRequest(brief).refused).toBe(false);
  });

  it('checks every text given (brief and product name)', () => {
    expect(checkRealPersonRequest('A nice review', 'Celebrity smoothie').refused).toBe(true);
    expect(checkRealPersonRequest(null, undefined, 'Oat latte').refused).toBe(false);
  });
});
