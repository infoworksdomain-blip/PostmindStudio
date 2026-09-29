import type { AuditEntry } from './audit';

// Phase 18 §2.6 — where audit entries go. `auditLog()` (audit.ts) keeps its signature and
// fire-and-forget behaviour; the sink behind it is chosen by STUDIO_AUDIT_SINK:
//   local → studio.audit_log (append-only, LocalAuditSink)
//   core  → PostMind Core's audit service (CoreAuditSink, the pre-Phase-18 code)
//   both  → both, in that order

export type AuditActorType = 'user' | 'staff' | 'system' | 'stripe' | 'meta';

/**
 * One audit row. `metadata` holds ids and codes only, never personal data. Every AuditEntry is
 * an AuditRecord; auth and system events may have no organisation or no acting user.
 */
export interface AuditRecord extends Omit<AuditEntry, 'actorUserId' | 'organisationId'> {
  actorUserId?: string;
  organisationId?: string;
  actorType?: AuditActorType;
  impersonatorUserId?: string;
  ip?: string;
  userAgent?: string;
  correlationId?: string;
  occurredAt?: Date;
}

export interface AuditSink {
  readonly kind: 'local' | 'core' | 'both';
  /** Persist one entry. Rejects when the entry could not be stored (callers decide what then). */
  write(record: AuditRecord): Promise<void>;
}

/** New Phase 18 audit actions (§2.6), so callers share one spelling. */
export const AuditAction = {
  SignIn: 'auth.sign_in',
  SignInFailed: 'auth.sign_in_failed',
  SignUp: 'auth.sign_up',
  EmailVerified: 'auth.email_verified',
  PasswordReset: 'auth.password_reset',
  PasswordChanged: 'auth.password_changed',
  EmailChanged: 'auth.email_changed',
  TwoFactorEnabled: 'auth.2fa_enabled',
  TwoFactorDisabled: 'auth.2fa_disabled',
  SessionRevoked: 'auth.session_revoked',
  AccountDeletionScheduled: 'auth.account_deletion_scheduled',
  MemberInvited: 'member.invited',
  MemberJoined: 'member.joined',
  MemberRoleChanged: 'member.role_changed',
  MemberRemoved: 'member.removed',
  OrgCreated: 'org.created',
  OrgRenamed: 'org.renamed',
  OrgDeleted: 'org.deleted',
  BillingCheckoutStarted: 'billing.checkout_started',
  BillingSubscriptionChanged: 'billing.subscription_changed',
  BillingPaymentFailed: 'billing.payment_failed',
  BillingTopupPurchased: 'billing.topup_purchased',
  EntitlementOverrideSet: 'entitlement.override_set',
  StaffRoleChanged: 'staff.role_changed',
  StaffImpersonationStarted: 'staff.impersonation_started',
  StaffImpersonationEnded: 'staff.impersonation_ended',
  MetaConnected: 'meta.connected',
  MetaDisconnected: 'meta.disconnected',
  BusinessCreated: 'business.created',
  BusinessDeleted: 'business.deleted',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
