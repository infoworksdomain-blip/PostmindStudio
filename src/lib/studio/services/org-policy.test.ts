import type { OrgPolicy } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../errors';
import { decideAutoApproval } from '../automation/review-policy';
import {
  autoApprovePolicyFor,
  defaultReviewPolicyFor,
  getOrgPolicy,
  orgPolicyInput,
  putOrgPolicy,
  viewPolicy,
} from './org-policy';

// BACKLOG 13.18 — per-organisation review policy (pure parts and the service against a fake
// table; test/api/org-admin.test.ts covers the routes on a real database).

const row = (over: Partial<OrgPolicy> = {}): OrgPolicy => ({
  organisationId: 'org-1',
  defaultReviewPolicy: null,
  autoApproveAllowed: true,
  autoApproveTrustThreshold: null,
  whiteLabel: false,
  updatedByUserId: 'staff-1',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-02T00:00:00Z'),
  ...over,
});

function fakeDb(initial: OrgPolicy | null = null) {
  let stored = initial;
  return {
    orgPolicy: {
      findUnique: vi.fn(async () => stored),
      upsert: vi.fn(
        async (args: { create: Partial<OrgPolicy>; update: Partial<OrgPolicy> }) =>
          (stored = row({ ...(stored ?? args.create), ...args.update })),
      ),
    },
  };
}

describe('orgPolicyInput', () => {
  it('accepts partial updates and nulls, refuses unknown fields and empty bodies', () => {
    expect(orgPolicyInput.parse({ autoApproveAllowed: false })).toEqual({
      autoApproveAllowed: false,
    });
    expect(
      orgPolicyInput.parse({ autoApproveTrustThreshold: null }).autoApproveTrustThreshold,
    ).toBeNull();
    expect(orgPolicyInput.safeParse({}).success).toBe(false);
    expect(orgPolicyInput.safeParse({ reviewPolicy: 'AUTO_APPROVE' }).success).toBe(false);
    expect(orgPolicyInput.safeParse({ autoApproveTrustThreshold: 0 }).success).toBe(false);
    expect(orgPolicyInput.safeParse({ defaultReviewPolicy: 'NEVER' }).success).toBe(false);
  });
});

describe('viewPolicy', () => {
  it('reports platform defaults and their sources when the organisation has no row', () => {
    expect(viewPolicy('org-1', null, {})).toMatchObject({
      policy: {
        defaultReviewPolicy: 'REQUIRE_APPROVAL',
        autoApproveTrustThreshold: 10,
        autoApproveAllowed: true,
      },
      source: {
        defaultReviewPolicy: 'default',
        autoApproveTrustThreshold: 'default',
        autoApproveAllowed: 'default',
      },
    });
    expect(
      viewPolicy('org-1', null, { STUDIO_AUTO_APPROVE_TRUST_THRESHOLD: '4' }).source
        .autoApproveTrustThreshold,
    ).toBe('env');
    expect(
      viewPolicy('org-1', null, { STUDIO_AUTO_APPROVE_TRUST_THRESHOLD: 'x' }).policy
        .autoApproveTrustThreshold,
    ).toBeNull();
  });

  it('prefers the organisation’s values', () => {
    const view = viewPolicy(
      'org-1',
      row({
        defaultReviewPolicy: 'AUTO_APPROVE',
        autoApproveTrustThreshold: 3,
        autoApproveAllowed: false,
        whiteLabel: true,
      }),
      {},
    );
    expect(view.policy).toEqual({
      defaultReviewPolicy: 'AUTO_APPROVE',
      autoApproveTrustThreshold: 3,
      autoApproveAllowed: false,
      whiteLabel: true,
    });
    expect(view.source.autoApproveTrustThreshold).toBe('organisation');
  });
});

describe('service', () => {
  it('get/put round trip keeps unspecified fields and records the actor', async () => {
    const db = fakeDb();
    expect((await getOrgPolicy(db as never, 'org-1')).policy.autoApproveAllowed).toBe(true);
    const { before, after } = await putOrgPolicy(
      db as never,
      'org-1',
      { autoApproveAllowed: false },
      'staff-2',
    );
    expect(before.policy.autoApproveAllowed).toBe(true);
    expect(after.policy.autoApproveAllowed).toBe(false);
    expect(db.orgPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { organisationId: 'org-1', autoApproveAllowed: false, updatedByUserId: 'staff-2' },
      }),
    );
  });

  it('rejects a blank organisation id', async () => {
    await expect(getOrgPolicy(fakeDb() as never, ' ')).rejects.toBeInstanceOf(ValidationError);
    await expect(
      putOrgPolicy(fakeDb() as never, '', { autoApproveAllowed: true }, 'x'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('default review policy for new projects: the row’s value or none', async () => {
    expect(await defaultReviewPolicyFor(fakeDb() as never, 'org-1')).toBeUndefined();
    expect(
      await defaultReviewPolicyFor(
        fakeDb(row({ defaultReviewPolicy: 'AUTO_APPROVE' })) as never,
        'org-1',
      ),
    ).toBe('AUTO_APPROVE');
  });

  it('auto-approve policy: org threshold overrides env, allowed=false blocks approval', async () => {
    const policy = await autoApprovePolicyFor(
      fakeDb(row({ autoApproveTrustThreshold: 2, autoApproveAllowed: false })) as never,
      'org-1',
      { STUDIO_AUTO_APPROVE_TRUST_THRESHOLD: '50' },
    );
    expect(policy).toEqual({ allowed: false, threshold: { ok: true, value: 2 } });
    const decision = decideAutoApproval({
      planTier: 'STANDARD',
      threshold: policy.threshold,
      humanApprovedCount: 99,
      renders: [
        {
          targetPlatform: 'tiktok',
          qualityCheckState: 'PASSED',
          qualityIssues: [
            { code: 'content_safety', status: 'passed', severity: 'info', detail: '' },
          ],
        },
      ],
      scriptSafetyVerdict: 'ALLOW',
      orgAllowsAutoApprove: policy.allowed,
    });
    expect(decision).toMatchObject({ decision: 'needs_review', code: 'org_policy' });
    const envOnly = await autoApprovePolicyFor(fakeDb() as never, 'org-1', {
      STUDIO_AUTO_APPROVE_TRUST_THRESHOLD: '50',
    });
    expect(envOnly).toEqual({ allowed: true, threshold: { ok: true, value: 50 } });
  });
});
