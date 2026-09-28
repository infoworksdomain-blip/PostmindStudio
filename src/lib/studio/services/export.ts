import { Prisma, type DataExport, type PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '../../errors';
import { collectExport, EXPORT_GROUPS, redactSecrets, type ExportGroup } from '../export/collect';
import { createZip, type ZipEntry } from '../export/zip';
import type { AssetStorage } from '../storage';

// BACKLOG 15.E1 — right of access (spec 18.4 "user can export all their Studio data at
// studio.postmind.ai/account/export"; A11.7 the business profile is exportable "via API export").
//   POST /account/export → a data_exports row (QUEUED) + the export-account-data job;
//   the job writes a ZIP to the assets bucket: one JSON file per table (tables/<name>.json,
//   organisation-scoped, secrets excluded — export/collect.ts), manifest.json (what is in it,
//   row counts, truncation) and assets.json (signed download URLs for the organisation's media,
//   valid for the 7-day life of the export — the SigV4 presign maximum);
//   GET /account/export/:id → state, and when READY a signed link that expires with the export.
// One export at a time per organisation (data_exports.activeKey is unique while QUEUED/RUNNING).

export const EXPORT_TTL_DAYS = 7;
export const EXPORT_TTL_SEC = EXPORT_TTL_DAYS * 24 * 60 * 60;
/** Signed media URLs listed in assets.json (the rest are counted as truncated). */
export const MAX_ASSET_URLS = 20_000;

export const requestExportInput = z
  .object({
    include: z
      .array(z.enum(EXPORT_GROUPS))
      .min(1)
      .max(EXPORT_GROUPS.length)
      .default([...EXPORT_GROUPS])
      .transform((v) => [...new Set(v)]),
  })
  .strict();

type Db = PrismaClient;

export interface ExportView {
  id: string;
  state: string;
  include: string[];
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  bytes: number | null;
  errorReason: string | null;
  summary: Prisma.JsonValue | null;
  downloadUrl?: string;
}

function view(row: DataExport): ExportView {
  return {
    id: row.id,
    state: row.state,
    include: row.include,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    bytes: row.bytes,
    errorReason: row.errorReason,
    summary: row.summary,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Create the export row; 409 while another export of the organisation is queued or running. */
export async function requestExport(
  db: Db,
  scope: { organisationId: string; userId: string },
  include: ExportGroup[],
): Promise<ExportView> {
  const active = await db.dataExport.findUnique({
    where: { activeKey: scope.organisationId },
    select: { id: true },
  });
  if (active) throw new ConflictError('An export is already being prepared for this organisation');
  try {
    // The unique activeKey still settles a race between two concurrent requests.
    const row = await db.dataExport.create({
      data: {
        organisationId: scope.organisationId,
        requestedByUserId: scope.userId,
        include,
        state: 'QUEUED',
        activeKey: scope.organisationId,
      },
    });
    return view(row);
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ConflictError('An export is already being prepared for this organisation');
    throw err;
  }
}

/** Mark an export failed (also frees the one-at-a-time slot). */
export async function failExport(db: Db, id: string, reason: string): Promise<void> {
  await db.dataExport.updateMany({
    where: { id, state: { in: ['QUEUED', 'RUNNING'] } },
    data: { state: 'FAILED', activeKey: null, errorReason: reason.slice(0, 500) },
  });
}

export async function listExports(db: Db, organisationId: string): Promise<ExportView[]> {
  const rows = await db.dataExport.findMany({
    where: { organisationId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return rows.map(view);
}

export async function getExport(
  deps: { db: Db; storage: AssetStorage; now: () => number },
  organisationId: string,
  id: string,
): Promise<ExportView> {
  const row = await deps.db.dataExport.findFirst({ where: { id, organisationId } });
  if (!row) throw new NotFoundError('Export not found');
  const out = view(row);
  const now = deps.now();
  if (row.state === 'READY' && row.s3Bucket && row.s3Key && row.expiresAt) {
    const remaining = Math.floor((row.expiresAt.getTime() - now) / 1000);
    if (remaining <= 0) return { ...out, state: 'EXPIRED' };
    out.downloadUrl = await deps.storage.signedUrl(row.s3Bucket, row.s3Key, remaining);
  }
  return out;
}

// ---------------------------------------------------------------- the job

interface AssetLink {
  type: 'video_asset' | 'render' | 'image' | 'upload';
  id: string;
  url: string;
}

async function assetLinks(
  deps: { db: Db; storage: AssetStorage },
  organisationId: string,
  include: ExportGroup[],
  projectIds: string[],
): Promise<{ links: AssetLink[]; truncated: boolean }> {
  const refs: Array<{ type: AssetLink['type']; id: string; bucket: string; key: string }> = [];
  if (include.includes('projects')) {
    const [assets, renders, uploads] = await Promise.all([
      deps.db.videoAsset.findMany({
        where: { organisationId, projectId: { in: projectIds } },
        select: { id: true, s3Bucket: true, s3Key: true },
      }),
      deps.db.videoRender.findMany({
        where: { projectId: { in: projectIds } },
        select: { id: true, s3Bucket: true, s3Key: true },
      }),
      deps.db.videoUpload.findMany({
        where: { organisationId, state: 'READY' },
        select: { id: true, s3Bucket: true, s3Key: true },
      }),
    ]);
    refs.push(
      ...assets.map((a) => ({
        type: 'video_asset' as const,
        id: a.id,
        bucket: a.s3Bucket,
        key: a.s3Key,
      })),
      ...renders.map((r) => ({
        type: 'render' as const,
        id: r.id,
        bucket: r.s3Bucket,
        key: r.s3Key,
      })),
      ...uploads.map((u) => ({
        type: 'upload' as const,
        id: u.id,
        bucket: u.s3Bucket,
        key: u.s3Key,
      })),
    );
  }
  if (include.includes('image_library')) {
    const images = await deps.db.imageLibraryItem.findMany({
      where: { organisationId },
      select: { id: true, s3Bucket: true, s3Key: true },
    });
    refs.push(
      ...images.map((i) => ({
        type: 'image' as const,
        id: i.id,
        bucket: i.s3Bucket,
        key: i.s3Key,
      })),
    );
  }
  const stored = refs.filter((r) => r.bucket && r.key);
  const links: AssetLink[] = [];
  for (const r of stored.slice(0, MAX_ASSET_URLS)) {
    links.push({
      type: r.type,
      id: r.id,
      url: await deps.storage.signedUrl(r.bucket, r.key, EXPORT_TTL_SEC),
    });
  }
  return { links, truncated: stored.length > MAX_ASSET_URLS };
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );
}

export interface ExportJobDeps {
  db: Db;
  storage: AssetStorage;
  logger: Logger;
  now: () => number;
  assetsBucket: string;
}

/** Build and store one export. Idempotent per state: only a QUEUED / RUNNING export runs. */
export async function runDataExport(deps: ExportJobDeps, exportId: string): Promise<void> {
  const claimed = await deps.db.dataExport.updateMany({
    where: { id: exportId, state: { in: ['QUEUED', 'RUNNING'] } },
    data: { state: 'RUNNING' },
  });
  if (claimed.count === 0) return;
  const row = await deps.db.dataExport.findUniqueOrThrow({ where: { id: exportId } });
  const include = row.include.filter((g): g is ExportGroup =>
    (EXPORT_GROUPS as readonly string[]).includes(g),
  );
  const collected = await collectExport(deps.db, row.organisationId, include);
  const assets = await assetLinks(deps, row.organisationId, include, collected.projectIds);
  const now = deps.now();
  const tables = Object.fromEntries(
    Object.entries(collected.tables).map(([name, rows]) => [name, rows.length]),
  );
  const manifest = {
    format: 'postmind-studio-export',
    version: 1,
    organisationId: row.organisationId,
    exportId: row.id,
    generatedAt: new Date(now).toISOString(),
    include,
    tables,
    truncated: collected.truncated,
    assets: { count: assets.links.length, truncated: assets.truncated },
    notes: [
      'Each tables/<name>.json holds the rows of one Studio table for this organisation.',
      'assets.json lists signed download links for media; they expire with this export (7 days).',
      'Access tokens, token hashes and other secrets are never included.',
    ],
  };
  const entries: ZipEntry[] = [
    { name: 'manifest.json', data: json(manifest) },
    { name: 'assets.json', data: json(assets.links) },
    ...Object.entries(collected.tables).map(([name, rows]) => ({
      name: `tables/${name}.json`,
      data: json(redactSecrets(rows)),
    })),
  ];
  const zip = createZip(entries);
  const key = `orgs/${row.organisationId}/exports/${row.id}.zip`;
  // 15.E9: the object may land in the fallback region's bucket; record where it really is.
  const stored = await deps.storage.put({
    bucket: deps.assetsBucket,
    key,
    body: zip,
    contentType: 'application/zip',
  });
  await deps.db.dataExport.update({
    where: { id: row.id },
    data: {
      state: 'READY',
      activeKey: null,
      s3Bucket: stored.bucket,
      s3Key: stored.key,
      bytes: zip.byteLength,
      summary: { tables, truncated: collected.truncated, assets: manifest.assets },
      completedAt: new Date(now),
      expiresAt: new Date(now + EXPORT_TTL_SEC * 1000),
    },
  });
  deps.logger.info(
    { exportId: row.id, organisationId: row.organisationId, bytes: zip.byteLength },
    'data export ready',
  );
}
