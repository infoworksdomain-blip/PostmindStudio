import { describe, expect, it, vi } from 'vitest';
import type { QualityCheck } from '../pipeline/quality-checks';
import {
  countHumanApprovedProjects,
  decideAutoApproval,
  DEFAULT_TRUST_THRESHOLD,
  trustThreshold,
  type AutoApprovalInput,
  type RenderForDecision,
} from './review-policy';

const passed = (code: string): QualityCheck => ({
  code,
  status: 'passed',
  severity: 'info',
  detail: 'ok',
});

const cleanRender = (overrides: Partial<RenderForDecision> = {}): RenderForDecision => ({
  targetPlatform: 'tiktok',
  qualityCheckState: 'PASSED',
  qualityIssues: [
    passed('duration_match'),
    passed('content_safety'),
    { code: 'watermark', status: 'not_run', severity: 'info', detail: 'not built' },
  ] as never,
  ...overrides,
});

const input = (overrides: Partial<AutoApprovalInput> = {}): AutoApprovalInput => ({
  planTier: 'STANDARD',
  threshold: { ok: true, value: 10 },
  humanApprovedCount: 10,
  renders: [cleanRender()],
  scriptSafetyVerdict: 'ALLOW',
  ...overrides,
});

describe('trustThreshold', () => {
  it('defaults to the spec’s first 10 videos', () => {
    expect(trustThreshold({})).toEqual({ ok: true, value: DEFAULT_TRUST_THRESHOLD });
    expect(trustThreshold({ STUDIO_AUTO_APPROVE_TRUST_THRESHOLD: ' ' })).toEqual({
      ok: true,
      value: 10,
    });
  });

  it('accepts integers from 1 to 1000', () => {
    expect(trustThreshold({ STUDIO_AUTO_APPROVE_TRUST_THRESHOLD: '3' })).toEqual({
      ok: true,
      value: 3,
    });
  });

  it.each(['0', '-1', '2.5', 'ten', '1001', '1e3'])('rejects %s', (raw) => {
    expect(trustThreshold({ STUDIO_AUTO_APPROVE_TRUST_THRESHOLD: raw }).ok).toBe(false);
  });
});

describe('decideAutoApproval', () => {
  it('auto-approves a trusted creator with a clean run (not_run checks allowed)', () => {
    expect(decideAutoApproval(input())).toEqual({ decision: 'auto_approve' });
  });

  it('keeps untrusted creators in review with a "first N videos" reason', () => {
    const decision = decideAutoApproval(input({ humanApprovedCount: 3 }));
    expect(decision).toMatchObject({ decision: 'needs_review', code: 'not_trusted' });
    expect(decision.decision === 'needs_review' && decision.reason).toContain(
      'first 10 videos — 3 of 10',
    );
  });

  it('20.9: an owner-approved month plan waives only the trust threshold', () => {
    const planned = { humanApprovedCount: 0, ownerPreApproved: true };
    expect(decideAutoApproval(input(planned))).toEqual({ decision: 'auto_approve' });
    // Safety, quality, enterprise and organisation policy still hold the video for a person.
    const flagged = cleanRender({
      qualityIssues: [{ ...passed('content_safety'), status: 'failed' }] as never,
    });
    expect(decideAutoApproval(input({ ...planned, renders: [flagged] }))).toMatchObject({
      code: 'content_safety_flag',
    });
    expect(decideAutoApproval(input({ ...planned, scriptSafetyVerdict: 'WARN' }))).toMatchObject({
      code: 'script_safety_flag',
    });
    expect(decideAutoApproval(input({ ...planned, planTier: 'ENTERPRISE' }))).toMatchObject({
      code: 'enterprise_plan',
    });
    expect(decideAutoApproval(input({ ...planned, orgAllowsAutoApprove: false }))).toMatchObject({
      code: 'org_policy',
    });
  });

  it('never auto-approves enterprise organisations', () => {
    expect(decideAutoApproval(input({ planTier: 'ENTERPRISE' }))).toMatchObject({
      code: 'enterprise_plan',
    });
  });

  it('disables auto-approval when the threshold is misconfigured', () => {
    expect(
      decideAutoApproval(input({ threshold: { ok: false, reason: 'bad value' } })),
    ).toMatchObject({ code: 'config_invalid' });
  });

  it('never auto-approves a force-approved render', () => {
    expect(
      decideAutoApproval(
        input({ renders: [cleanRender({ qualityCheckState: 'FORCE_APPROVED' })] }),
      ),
    ).toMatchObject({ code: 'force_approved' });
    const marked = cleanRender({
      qualityIssues: [passed('content_safety'), passed('force_approved')] as never,
    });
    expect(decideAutoApproval(input({ renders: [marked] }))).toMatchObject({
      code: 'force_approved',
    });
  });

  it('never auto-approves content-safety flags or a missing scan', () => {
    const flagged = cleanRender({
      qualityIssues: [
        { code: 'content_safety', status: 'failed', severity: 'error', detail: 'Needs review' },
      ] as never,
    });
    expect(decideAutoApproval(input({ renders: [flagged] }))).toMatchObject({
      code: 'content_safety_flag',
    });
    const unscanned = cleanRender({ qualityIssues: [passed('duration_match')] as never });
    expect(decideAutoApproval(input({ renders: [unscanned] }))).toMatchObject({
      code: 'content_safety_flag',
    });
  });

  it('20.21: a scan skipped for want of a provider follows the review policy', () => {
    const skipped = cleanRender({
      qualityIssues: [
        passed('duration_match'),
        {
          code: 'content_safety',
          status: 'not_run',
          severity: 'info',
          detail: 'Not scanned: no content-safety provider is configured',
          detailKey: 'safetyNotScanned',
          detailParams: { reason: 'no_provider' },
        },
      ] as never,
    });
    expect(decideAutoApproval(input({ renders: [skipped] }))).toEqual({
      decision: 'auto_approve',
    });
    // Still needs a person when the creator is not trusted yet.
    expect(decideAutoApproval(input({ renders: [skipped], humanApprovedCount: 0 }))).toMatchObject({
      code: 'not_trusted',
    });
  });

  it('needs review when any check failed or a render did not pass', () => {
    const failed = cleanRender({
      qualityIssues: [
        passed('content_safety'),
        { code: 'audio_present', status: 'failed', severity: 'error', detail: 'quiet' },
      ] as never,
    });
    expect(decideAutoApproval(input({ renders: [failed] }))).toMatchObject({
      code: 'quality_not_clean',
    });
    expect(
      decideAutoApproval(input({ renders: [cleanRender({ qualityCheckState: 'FAILED' })] })),
    ).toMatchObject({ code: 'quality_not_clean' });
    expect(decideAutoApproval(input({ renders: [] }))).toMatchObject({
      code: 'quality_not_clean',
    });
  });

  it.each(['WARN', 'REVIEW', undefined])('needs review for script safety verdict %s', (v) => {
    expect(decideAutoApproval(input({ scriptSafetyVerdict: v }))).toMatchObject({
      code: 'script_safety_flag',
    });
  });

  it('checks content before trust so the reason is the most useful one', () => {
    expect(
      decideAutoApproval(
        input({
          humanApprovedCount: 0,
          renders: [cleanRender({ qualityCheckState: 'FORCE_APPROVED' })],
        }),
      ),
    ).toMatchObject({ code: 'force_approved' });
  });
});

describe('countHumanApprovedProjects', () => {
  it('counts other projects of the creator with a non-system APPROVED approval', async () => {
    const count = vi.fn(async () => 4);
    const db = { videoProject: { count } } as never;
    await expect(
      countHumanApprovedProjects(db, { organisationId: 'o', userId: 'u', excludeProjectId: 'p' }),
    ).resolves.toBe(4);
    expect(count).toHaveBeenCalledWith({
      where: {
        organisationId: 'o',
        createdByUserId: 'u',
        id: { not: 'p' },
        approvals: {
          some: {
            state: 'APPROVED',
            resolvedByUserId: { not: null },
            NOT: { resolvedByUserId: { startsWith: 'system:' } },
          },
        },
      },
    });
  });
});

describe('20.9 isPlanPreApproved', () => {
  it('reads metadata.contentPlan.preApproved (true only)', async () => {
    const { isPlanPreApproved } = await import('./auto-approve');
    expect(isPlanPreApproved({ contentPlan: { planId: 'p', preApproved: true } })).toBe(true);
    expect(isPlanPreApproved({ contentPlan: { planId: 'p', preApproved: false } })).toBe(false);
    expect(isPlanPreApproved({ contentPlan: { preApproved: 'yes' } })).toBe(false);
    expect(isPlanPreApproved(null)).toBe(false);
  });
});
