import { describe, expect, it } from 'vitest';
import { combineScriptSafety, scriptsWithSafety, type ScriptSafetyResult } from './script-safety';

// 23.2 — scripts are written in parallel and each one's safety check starts as soon as it is
// written; the verdicts combine to the most severe.

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const allow: ScriptSafetyResult = { verdict: 'ALLOW', categories: [], reason: 'ordinary' };

describe('scriptsWithSafety', () => {
  it('starts every script before any is awaited, and checks each as soon as it is written', async () => {
    const writes = new Map([
      ['tiktok', deferred<string>()],
      ['youtube', deferred<string>()],
    ]);
    const started: string[] = [];
    const checked: string[] = [];
    const run = scriptsWithSafety(
      ['tiktok', 'youtube'],
      (format) => {
        started.push(format);
        return writes.get(format)!.promise;
      },
      async (script) => {
        checked.push(script);
        return allow;
      },
    );
    // Both writes are in flight before either has finished.
    expect(started).toEqual(['tiktok', 'youtube']);
    writes.get('youtube')!.resolve('youtube script');
    await new Promise((r) => setTimeout(r, 0));
    // The finished script is checked while the other is still being written.
    expect(checked).toEqual(['youtube script']);
    writes.get('tiktok')!.resolve('tiktok script');
    await expect(run).resolves.toEqual({
      scripts: ['tiktok script', 'youtube script'],
      safety: { verdict: 'ALLOW', categories: [], reason: 'ordinary' },
    });
  });

  it('rejects with the first failure (the job retry re-plans everything)', async () => {
    await expect(
      scriptsWithSafety(
        ['a', 'b'],
        async (v) => {
          if (v === 'b') throw new Error('script failed');
          return v;
        },
        async () => allow,
      ),
    ).rejects.toThrow('script failed');
    await expect(
      scriptsWithSafety(
        ['a'],
        async (v) => v,
        async () => {
          throw new Error('safety failed');
        },
      ),
    ).rejects.toThrow('safety failed');
  });
});

describe('combineScriptSafety', () => {
  it('keeps the most severe verdict, every category and that verdict’s reasons', () => {
    expect(
      combineScriptSafety([
        allow,
        { verdict: 'REVIEW', categories: ['medical_misinformation'], reason: 'health claim' },
        { verdict: 'WARN', categories: ['financial_scam'], reason: 'borderline' },
      ]),
    ).toEqual({
      verdict: 'REVIEW',
      categories: ['medical_misinformation', 'financial_scam'],
      reason: 'health claim',
    });
    expect(
      combineScriptSafety([
        { verdict: 'BLOCK', categories: ['hate_speech'], reason: 'slur' },
        { verdict: 'REVIEW', categories: ['public_figure'], reason: 'names a celebrity' },
      ]).verdict,
    ).toBe('BLOCK');
  });

  it('is ALLOW with no scripts', () => {
    expect(combineScriptSafety([])).toEqual({ verdict: 'ALLOW', categories: [], reason: '' });
  });
});
