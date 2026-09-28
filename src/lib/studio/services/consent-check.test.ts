import { describe, expect, it, vi } from 'vitest';
import { CostCapPausedError } from '../../errors';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import { createCircuitBreaker } from '../providers/circuit-breaker';
import { createProviderRegistry } from '../providers/registry';
import { StubAdapter } from '../providers/test-adapter';
import {
  checkConsentRecording,
  consentSimilarity,
  consentWords,
  matchConsent,
  stateAfterConsent,
} from './consent-check';

const STATEMENT =
  'I, Amara Okafor, consent to PostMind Studio creating a synthetic copy of my voice for Bread & Co videos.';

describe('consent matcher (15.C7)', () => {
  it('normalises words, punctuation and accents', () => {
    expect(consentWords('Café, CAFÉ!  crème-brûlée')).toEqual(['cafe', 'cafe', 'creme', 'brulee']);
  });

  it.each([
    ['exact', STATEMENT, 'passed'],
    [
      'fillers and a split word',
      'um I Amara Okafor consent to Post Mind Studio creating a synthetic copy of my voice for bread and co videos',
      'passed',
    ],
    ['another sentence', 'Hello, this is a test recording of my voice', 'mismatch'],
    ['half the statement', 'I Amara Okafor consent to PostMind Studio', 'mismatch'],
    [
      'another speaker name',
      'I, Jane Doe, consent to PostMind Studio creating a synthetic copy of my voice for Bread & Co videos.',
      'mismatch',
    ],
    ['silence', '', 'mismatch'],
  ])('%s → %s', (_label, transcript, check) => {
    expect(
      matchConsent({ statement: STATEMENT, speakerName: 'Amara Okafor', transcript }).check,
    ).toBe(check);
  });

  it('scores the share of statement words heard in order', () => {
    expect(consentSimilarity('a b c d', 'a x b c')).toBe(0.75);
    expect(consentSimilarity('', 'anything')).toBe(0);
  });

  it('maps checks to profile states', () => {
    expect(stateAfterConsent('passed', false)).toBe('READY');
    expect(stateAfterConsent('passed', true)).toBe('REQUIRES_VERIFICATION');
    expect(stateAfterConsent('mismatch', false)).toBe('PENDING_REVIEW');
    expect(stateAfterConsent('unavailable', false)).toBe('PENDING_REVIEW');
  });
});

describe('checkConsentRecording', () => {
  function deps(adapter?: StubAdapter, budget?: ProviderRunDeps['budget']): ProviderRunDeps {
    const breaker = createCircuitBreaker(() => 0);
    const killSwitch = {
      check: vi.fn(async () => ({ killed: false as const })),
      assertNotKilled: vi.fn(),
    };
    let created = 0;
    const rows = new Map<string, Record<string, unknown>>();
    return {
      registry: createProviderRegistry(adapter ? [adapter] : []),
      breaker,
      killSwitch,
      budget: budget ?? { hasBudget: async () => true },
      tracking: {
        repo: {
          create: async (job: { organisationId: string; provider: string }) => {
            const row = {
              id: `job-${(created += 1)}`,
              organisationId: job.organisationId,
              projectId: null,
              provider: job.provider,
              providerJobId: null,
              state: 'PENDING',
              startedAt: new Date(0),
              costPence: 0,
            };
            rows.set(row.id, row);
            return row;
          },
          find: async (id: string) => rows.get(id) ?? null,
          markRunning: async (id: string, providerJobId: string) => {
            rows.set(id, { ...rows.get(id), state: 'RUNNING', providerJobId });
          },
          markSucceeded: async () => undefined,
          markFailed: async () => undefined,
          recordUsage: async () => undefined,
        },
        killSwitch,
        breaker,
        now: () => 0,
      },
      config: { providerTimeoutMs: 600_000, providerPollIntervalMs: 5_000 },
      now: () => 0,
      sleep: async () => undefined,
    } as unknown as ProviderRunDeps;
  }
  const input = {
    organisationId: 'org-1',
    planTier: 'PLUS' as const,
    mediaUrl: 'https://signed.example/c.mp3',
    statement: STATEMENT,
    speakerName: 'Amara Okafor',
  };

  it('transcribes through the router and matches', async () => {
    const stub = new StubAdapter('assemblyai', ['transcription']);
    stub.nextPoll = async () => ({ state: 'succeeded', output: { metadata: { text: STATEMENT } } });
    expect(await checkConsentRecording(deps(stub), input)).toMatchObject({
      check: 'passed',
      similarity: 1,
    });
    expect(stub.submitCalls[0]).toMatchObject({
      capability: 'transcription',
      mediaUrl: input.mediaUrl,
    });
  });

  it('is unavailable without a transcription provider', async () => {
    expect(await checkConsentRecording(deps(), input)).toMatchObject({
      check: 'unavailable',
      transcript: null,
    });
  });

  it('lets a cost-cap pause through (it is not a consent result)', async () => {
    const stub = new StubAdapter('assemblyai', ['transcription']);
    const paused = deps(stub, {
      hasBudget: async () => true,
      assertNotPaused: async () => {
        throw new CostCapPausedError('organisation_daily' as never, 'paused');
      },
    });
    await expect(checkConsentRecording(paused, input)).rejects.toBeInstanceOf(CostCapPausedError);
  });
});
