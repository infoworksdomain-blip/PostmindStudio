// Provider-job cost ledger (agent "insight"), shared by /analytics/cost (Leeds Sourdough only) and
// the Admin Centre (/admin/cost, /admin/cost/caps across organisations). Pence, UTC days,
// relative to page load. Leeds Sourdough's rows follow its projects' production days.
import { DEMO_ORG_ID, PROJECTS } from '../ids';
import { OTHER_ORGS } from './admin-state';

export interface LedgerRow {
  day: string;
  organisationId: string;
  projectId: string | null;
  provider: string;
  jobs: number;
  succeeded: number;
  failed: number;
  costPence: number;
}

const DAY = 86_400_000;
const t0 = Date.now();
export const dayKey = (offsetDays: number): string =>
  new Date(t0 - offsetDays * DAY).toISOString().slice(0, 10);

/** One three-format video's provider mix: [provider, jobs, pence, stage]. */
const VIDEO_MIX: Array<[string, number, number, 'plan' | 'make']> = [
  ['anthropic', 5, 42, 'plan'],
  ['openai', 2, 14, 'plan'],
  ['runway', 6, 1450, 'make'],
  ['luma', 4, 760, 'make'],
  ['elevenlabs', 3, 54, 'make'],
  ['elevenlabs-music', 1, 38, 'make'],
  ['shotstack', 3, 126, 'make'],
  ['hive', 3, 9, 'make'],
];

const rows: LedgerRow[] = [];

function add(
  org: string,
  projectId: string | null,
  offset: number,
  provider: string,
  jobs: number,
  pence: number,
  failed = 0,
) {
  if (jobs <= 0) return;
  rows.push({
    day: dayKey(offset),
    organisationId: org,
    projectId,
    provider,
    jobs,
    succeeded: jobs - failed,
    failed,
    costPence: Math.round(pence),
  });
}

/** A project's spend: planning on `planDay`, generation/composition on `makeDay`. */
function project(
  id: string,
  planDay: number,
  makeDay: number,
  scale: number,
  opts: { skip?: string[]; failed?: Record<string, number> } = {},
) {
  for (const [provider, jobs, pence, stage] of VIDEO_MIX) {
    if (opts.skip?.includes(provider)) continue;
    const j = Math.max(1, Math.round(jobs * scale));
    add(
      DEMO_ORG_ID,
      id,
      stage === 'plan' ? planDay : makeDay,
      provider,
      j,
      pence * scale,
      opts.failed?.[provider] ?? 0,
    );
  }
}

// Leeds Sourdough — matches the projects' states in ids.ts.
project(PROJECTS.meetTheBakers.id, 15, 15, 0.4, {
  skip: ['runway', 'luma', 'elevenlabs', 'elevenlabs-music', 'shotstack', 'hive'],
});
project(PROJECTS.morningRitual.id, 11, 10, 0.9);
project(PROJECTS.sourdoughClass.id, 9, 8, 1.1, { failed: { runway: 1 } });
project(PROJECTS.hotCrossBuns.id, 6, 5, 0.8, { failed: { shotstack: 1 } });
project(PROJECTS.wholesale.id, 5, 4, 0.7);
project(PROJECTS.fiveBakes.id, 3, 3, 0.6, { skip: ['runway', 'luma', 'elevenlabs'] });
project(PROJECTS.springMenu.id, 2, 1, 1.0);
project(PROJECTS.christmas.id, 1, 1, 1.28, { failed: { runway: 2 } });
project(PROJECTS.loyaltyCard.id, 0, 0, 1.12, { skip: ['anthropic', 'openai'] });
add(DEMO_ORG_ID, PROJECTS.loyaltyCard.id, 1, 'anthropic', 5, 47);
add(DEMO_ORG_ID, PROJECTS.loyaltyCard.id, 1, 'openai', 2, 16);
// Business scans and weekly content suggestions (no project).
for (let d = 0; d < 90; d += 1) {
  if (d % 7 === 1) add(DEMO_ORG_ID, null, d, 'anthropic', 3, 24 + (d % 5) * 3);
  // Daily caption/hashtag suggestions and moderation checks on scheduled posts.
  if (d % 3 !== 2) add(DEMO_ORG_ID, null, d, 'anthropic', 2 + (d % 3), 9 + ((d * 7) % 11));
  if (d % 4 === 0) add(DEMO_ORG_ID, null, d, 'hive', 2, 3);
}
add(DEMO_ORG_ID, null, 20, 'openai', 4, 32);

// Other organisations (admin views): seeded pseudo-random daily usage.
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ORG_PROFILES: Array<[string, number, string[]]> = [
  [OTHER_ORGS.harrogate, 1500, ['runway', 'luma', 'elevenlabs', 'shotstack', 'anthropic', 'hive']],
  [
    OTHER_ORGS.york,
    4200,
    ['runway', 'luma', 'kling', 'elevenlabs', 'elevenlabs-music', 'shotstack', 'anthropic', 'hive'],
  ],
  [OTHER_ORGS.bramley, 600, ['pika', 'elevenlabs', 'shotstack', 'anthropic']],
  [OTHER_ORGS.kirkstall, 450, ['luma', 'elevenlabs', 'creatomate', 'anthropic']],
  [OTHER_ORGS.platform, 2600, ['anthropic', 'openai', 'assemblyai', 'hive']],
];
const SHARE: Record<string, number> = {
  runway: 0.5,
  luma: 0.25,
  kling: 0.2,
  pika: 0.35,
  elevenlabs: 0.05,
  'elevenlabs-music': 0.03,
  shotstack: 0.06,
  creatomate: 0.08,
  anthropic: 0.08,
  openai: 0.25,
  assemblyai: 0.3,
  hive: 0.02,
};
ORG_PROFILES.forEach(([org, daily, providers], oi) => {
  const rnd = prng(97 + oi * 31);
  for (let d = 0; d < 90; d++) {
    // Bramley is frozen (workspace kill switch) for the last two days; Pika is disabled for three.
    const frozen = org === OTHER_ORGS.bramley && d < 2;
    if (frozen || rnd() < 0.18) continue;
    const dayTotal = daily * (0.45 + rnd() * 1.1) * (d < 30 ? 1 : 0.8);
    for (const p of providers) {
      if (p === 'pika' && d < 3) continue;
      const pence = dayTotal * (SHARE[p] ?? 0.05) * (0.7 + rnd() * 0.6);
      const jobs = Math.max(
        1,
        Math.round(
          pence / (p === 'runway' || p === 'pika' || p === 'kling' ? 240 : p === 'luma' ? 190 : 30),
        ),
      );
      const failed = rnd() < 0.12 ? 1 : 0;
      add(org, null, d, p, jobs, pence, Math.min(failed, jobs));
    }
  }
});

export const ledger = (): LedgerRow[] => rows;

export const TIERS: Record<string, string> = {
  [DEMO_ORG_ID]: 'STANDARD',
  [OTHER_ORGS.harrogate]: 'STANDARD',
  [OTHER_ORGS.york]: 'PLUS',
  [OTHER_ORGS.bramley]: 'BASIC',
  [OTHER_ORGS.kirkstall]: 'BASIC',
  [OTHER_ORGS.platform]: 'ENTERPRISE',
};

/** Sum rows by a key into [{key, costPence, jobs}] sorted by cost. */
export function rollup<K extends string | null>(list: LedgerRow[], by: (r: LedgerRow) => K) {
  const map = new Map<K, { costPence: number; jobs: number }>();
  for (const r of list) {
    const k = by(r);
    const cur = map.get(k) ?? { costPence: 0, jobs: 0 };
    map.set(k, { costPence: cur.costPence + r.costPence, jobs: cur.jobs + r.jobs });
  }
  return [...map.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.costPence - a.costPence);
}
