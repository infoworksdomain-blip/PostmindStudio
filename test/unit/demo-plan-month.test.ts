// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import '../../demo/api/handlers/index';
import { handle } from '../../demo/api/registry';

// 20.9 — the demo's "Plan my month": the seeded half-made October plan (scheduled posts, posts
// still being made, one held by the safety check), a new plan that drafts and then generates over
// successive reads, and the calendar's planned markers.

type Item = { id: string; status: string; title: string; kind: string };
type Plan = { id: string; status: string; items: Item[]; counts: Record<string, number> };

async function api(path: string, method = 'GET', body?: unknown) {
  const res = await handle(new URL(`https://studio.demo/api/studio${path}`), {
    method,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('demo: plan my month (20.9)', { timeout: 30_000 }, () => {
  it('seeds a half-made plan that shows on the calendar', async () => {
    const { json } = await api('/content-plans/plan-october');
    const plan = json.plan as Plan;
    expect(plan.status).toBe('GENERATING');
    expect(plan.counts.SCHEDULED).toBe(7);
    expect(plan.counts.HELD).toBe(1);
    const upcoming = await api('/businesses/biz-leeds-sourdough/drip-queue/upcoming');
    const planned = (upcoming.json.upcoming as { planned: Array<{ planId: string }> }).planned;
    expect(planned.some((p) => p.planId === 'plan-october')).toBe(true);
  });

  it('drafts a new month over a few reads, then generates and schedules it', async () => {
    const defaults = await api('/content-plans/defaults?businessId=biz-leeds-sourdough');
    expect(defaults.json.defaults).toMatchObject({ days: 30, hasPostingTimes: true });
    const created = await api('/content-plans', 'POST', {
      businessId: 'biz-leeds-sourdough',
      days: 3,
      postsPerDay: 2,
      videoShare: 50,
      platforms: ['tiktok'],
      targets: [{ platform: 'tiktok', connectionId: 'conn-tiktok' }],
    });
    expect(created.status).toBe(202);
    const id = (created.json.plan as Plan).id;
    let plan = created.json.plan as Plan;
    for (let i = 0; i < 6 && plan.status !== 'DRAFT'; i += 1)
      plan = (await api(`/content-plans/${id}`)).json.plan as Plan;
    expect(plan.status).toBe('DRAFT');
    expect(plan.items.every((it) => it.title.length > 0)).toBe(true);

    expect((await api(`/content-plans/${id}/generate`, 'POST')).status).toBe(202);
    for (let i = 0; i < 12 && plan.status !== 'SCHEDULED'; i += 1)
      plan = (await api(`/content-plans/${id}`)).json.plan as Plan;
    expect(plan.status).toBe('SCHEDULED');
    expect(plan.counts.SCHEDULED).toBe(plan.items.length);

    const first = plan.items[0]!;
    const removed = await api(`/content-plans/${id}/items/${first.id}`, 'DELETE');
    expect((removed.json.plan as Plan).items.find((i) => i.id === first.id)?.status).toBe(
      'REMOVED',
    );
  });
});
