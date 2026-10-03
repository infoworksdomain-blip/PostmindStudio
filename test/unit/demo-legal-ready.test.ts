// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import '../../demo/api/handlers/index';
import { handle } from '../../demo/api/registry';

// The demo mirrors live: the legal documents are published, so the Admin Centre shows no
// "not ready for launch" warning and public sign-up is open.
describe('demo: legal readiness', { timeout: 30_000 }, () => {
  it('reports every document ready and sign-up open', async () => {
    const res = await handle(new URL('https://studio.demo/api/studio/admin/legal-readiness'));
    const json = (await res.json()) as {
      readiness: {
        ready: boolean;
        launchBlockers: string[];
        docs: Array<{ placeholder: boolean }>;
      };
      signups: { open: boolean; reason?: string };
    };
    expect(json.readiness.ready).toBe(true);
    expect(json.readiness.launchBlockers).toEqual([]);
    expect(json.readiness.docs).toHaveLength(6);
    expect(json.readiness.docs.every((d) => !d.placeholder)).toBe(true);
    expect(json.signups).toEqual({ open: true });
  });
});
