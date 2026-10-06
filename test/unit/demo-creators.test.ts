// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import '../../demo/api/handlers/index';
import { handle } from '../../demo/api/registry';

// 22.3 — the demo's reusable creators: the sample business has two READY creators (the Create
// picker defaults to the most used), and create / rename / make default / retire behave like the
// real routes, including the real-person refusal and a retired creator dropping off the list.

type Creator = { id: string; name: string; status: string; isDefault: boolean; useCount: number };

async function api(path: string, method = 'GET', body?: unknown) {
  const res = await handle(new URL(`https://studio.demo/api/studio${path}`), {
    method,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const base = '/businesses/biz-leeds-sourdough/creators';

describe('demo: reusable creators (22.3)', { timeout: 30_000 }, () => {
  it('seeds two ready creators, most used first, with portraits and no cost', async () => {
    const { json } = await api(base);
    const data = json.data as Array<Creator & Record<string, unknown>>;
    expect(data.slice(0, 2).map((c) => c.name)).toEqual(['Maya', 'Tom']);
    expect(data.every((c) => c.status === 'READY' && typeof c.portraitUrl === 'string')).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(/costPence|£/);
  });

  it('creates, renames, makes default and retires a creator', async () => {
    const created = await api(base, 'POST', {
      name: 'Ava',
      gender: 'woman',
      ageRange: '18-24',
      setting: 'desk',
    });
    expect(created.status).toBe(201);
    const id = (created.json.creator as Creator).id;
    const renamed = await api(`${base}/${id}`, 'PATCH', { name: 'Ava B' });
    expect((renamed.json.creator as Creator).name).toBe('Ava B');
    await api(`${base}/${id}`, 'PATCH', { isDefault: true });
    const list = (await api(base)).json.data as Creator[];
    expect(list.filter((c) => c.isDefault).map((c) => c.id)).toEqual([id]);
    const retired = await api(`${base}/${id}/retire`, 'POST');
    expect((retired.json.creator as Creator).status).toBe('RETIRED');
    expect(((await api(base)).json.data as Creator[]).some((c) => c.id === id)).toBe(false);
  });

  it('refuses a real-person request', async () => {
    const res = await api(base, 'POST', {
      name: 'Celebrity look-alike',
      gender: 'man',
      ageRange: '25-34',
      setting: 'car',
    });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ details: { reason: 'ugc_real_person_refused' } });
  });
});
