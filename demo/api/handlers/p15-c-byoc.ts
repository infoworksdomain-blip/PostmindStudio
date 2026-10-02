// Phase 15 track C, operator decision P1 (BYOC) demo handlers. Shapes match
// src/app/api/studio/provider-credentials/** and projects/[id]/byoc (services/
// provider-credentials.ts presentCredential). The demo organisation is Enterprise with BYOC on;
// keys are held in memory only as their last four characters, and "Test" reports that the demo
// makes no provider call (it never pretends a key works).
import { DemoHttpError, route } from '../registry';

interface DemoCredential {
  providerId: string;
  hint: string | null;
  state: 'active' | 'revoked';
  lastTestedAt: string | null;
  lastTestResult: { healthy: boolean; reason?: string } | null;
  updatedAt: string;
}

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', twoPart: false },
  { id: 'openai', label: 'OpenAI', twoPart: false },
  { id: 'assemblyai', label: 'AssemblyAI', twoPart: false },
  { id: 'runway', label: 'Runway', twoPart: false },
  { id: 'luma', label: 'Luma', twoPart: false },
  { id: 'heygen', label: 'HeyGen', twoPart: false },
  { id: 'elevenlabs', label: 'ElevenLabs', twoPart: false },
  { id: 'shotstack', label: 'Shotstack', twoPart: false },
  { id: 'storyblocks', label: 'Storyblocks', twoPart: true },
  { id: 'pexels', label: 'Pexels', twoPart: false },
];

const credentials = new Map<string, DemoCredential>([
  [
    'runway',
    {
      providerId: 'runway',
      hint: '7Qx2',
      state: 'active',
      lastTestedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      lastTestResult: { healthy: true },
      updatedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    },
  ],
]);

function provider(id: string | undefined) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new DemoHttpError(404, 'not_found', 'Unknown provider for bring-your-own keys');
  return p;
}

const keyOf = (body: unknown, field: string) => {
  const v = (body as Record<string, unknown> | undefined)?.[field];
  return typeof v === 'string' ? v.trim() : '';
};

function active(id: string): DemoCredential {
  const c = credentials.get(id);
  if (!c || c.state !== 'active')
    throw new DemoHttpError(404, 'not_found', 'No active key for this provider');
  return c;
}

route('GET', '/provider-credentials', () => ({
  enabled: true,
  providers: PROVIDERS,
  credentials: [...credentials.values()],
}));

route('PUT', '/provider-credentials/:providerId', ({ params, body }) => {
  const p = provider(params.providerId);
  const apiKey = keyOf(body, 'apiKey');
  const secondaryKey = keyOf(body, 'secondaryKey');
  const problems: string[] = [];
  if (apiKey.length < 8 || apiKey.length > 512) problems.push('apiKey: 8–512 characters');
  if (p.twoPart && secondaryKey.length < 8) problems.push('secondaryKey: required');
  if (!p.twoPart && secondaryKey) problems.push('secondaryKey: not used by this provider');
  if (problems.length)
    throw new DemoHttpError(400, 'validation_error', 'Request body failed validation', {
      problems,
    });
  const credential: DemoCredential = {
    providerId: p.id,
    hint: apiKey.slice(-4),
    state: 'active',
    lastTestedAt: null,
    lastTestResult: null,
    updatedAt: new Date().toISOString(),
  };
  credentials.set(p.id, credential);
  return { credential };
});

route('POST', '/provider-credentials/:providerId/test', ({ params }) => {
  const p = provider(params.providerId);
  const current = active(p.id);
  const result = { healthy: false, reason: 'demo build: no provider call is made' };
  credentials.set(p.id, {
    ...current,
    lastTestedAt: new Date().toISOString(),
    lastTestResult: result,
  });
  return result;
});

route('DELETE', '/provider-credentials/:providerId', ({ params }) => {
  const p = provider(params.providerId);
  const current = active(p.id);
  const credential: DemoCredential = {
    ...current,
    state: 'revoked',
    updatedAt: new Date().toISOString(),
  };
  credentials.set(p.id, credential);
  return { credential };
});

route('PUT', '/projects/:id/byoc', ({ params, body }) => {
  const mode = (body as Record<string, unknown> | undefined)?.mode;
  if (mode !== 'org' && mode !== 'platform')
    throw new DemoHttpError(400, 'validation_error', 'mode must be "org" or "platform"');
  return { projectId: params.id, byoc: mode };
});
