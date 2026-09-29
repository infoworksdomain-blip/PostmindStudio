import type { Prisma, PrismaClient } from '@prisma/client';
import { deliverAuditEntry, type AuditDeliveryDeps } from './audit';
import type { AuditRecord, AuditSink } from './audit-sink';
import { UpstreamServiceError } from './errors';

// Phase 18 §2.6 — the audit sinks behind auditLog() / auditLogDurable().

const MAX_TEXT = 512;

function clip(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
}

/** studio.audit_log (append-only; the DB trigger refuses updates and deletes). */
export function createLocalAuditSink(db: Pick<PrismaClient, 'auditLog'>): AuditSink {
  return {
    kind: 'local',
    async write(record: AuditRecord) {
      await db.auditLog.create({
        data: {
          occurredAt: record.occurredAt ?? new Date(),
          actorUserId: clip(record.actorUserId),
          actorType: record.actorType ?? (record.actorUserId ? 'user' : 'system'),
          impersonatorUserId: clip(record.impersonatorUserId),
          organisationId: clip(record.organisationId),
          action: record.action,
          resourceType: record.resource.type,
          resourceId: record.resource.id,
          metadata: (record.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
          ip: clip(record.ip),
          userAgent: clip(record.userAgent),
          correlationId: clip(record.correlationId),
        },
      });
    },
  };
}

/** PostMind Core's audit service (the pre-Phase-18 delivery, with its retries). */
export function createCoreAuditSink(deps: AuditDeliveryDeps = {}): AuditSink {
  return {
    kind: 'core',
    async write(record: AuditRecord) {
      const delivered = await deliverAuditEntry(
        {
          actorUserId: record.actorUserId ?? 'system',
          organisationId: record.organisationId ?? 'none',
          action: record.action,
          resource: record.resource,
          metadata: {
            ...record.metadata,
            ...(record.correlationId && { correlationId: record.correlationId }),
            ...(record.impersonatorUserId && { impersonatorUserId: record.impersonatorUserId }),
          },
        },
        deps,
      );
      if (!delivered) throw new UpstreamServiceError('Audit entry was not delivered to Core');
    },
  };
}

/** STUDIO_AUDIT_SINK=both: local first (the durable one), then Core. */
export function createBothAuditSink(local: AuditSink, core: AuditSink): AuditSink {
  return {
    kind: 'both',
    async write(record) {
      await local.write(record);
      await core.write(record);
    },
  };
}
