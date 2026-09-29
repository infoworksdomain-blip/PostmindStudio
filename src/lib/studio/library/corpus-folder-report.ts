import { REJECT_EXPLANATION, type FileVerdict, type RejectReason } from './corpus-folder';
import type { FolderScan } from './corpus-folder-scan';

// Phase 19 Track 1 — the numbers and the plain-English summary of scripts/corpus/scan-folder.ts.

/**
 * Cloudflare R2 Standard storage prices, from https://developers.cloudflare.com/r2/pricing/
 * (page "Last updated Aug 7, 2026", read 2026-09-29). Egress is free. The estimate treats a GB
 * as 10^9 bytes (the larger count, so the higher price).
 */
export const R2_PRICING = {
  source: 'https://developers.cloudflare.com/r2/pricing/',
  readOn: '2026-09-29',
  usdPerGbMonth: 0.015,
  freeGbMonth: 10,
  classAUsdPerMillion: 4.5,
  freeClassAPerMonth: 1_000_000,
} as const;

export const UPLOAD_SPEEDS_MBIT = [10, 50, 100] as const;

export interface UploadEstimate {
  mbitPerSec: number;
  hours: number;
}

/** Best case at the full line speed; real uploads usually run 10–30% slower. */
export function uploadHours(bytes: number, mbitPerSec: number): number {
  return (bytes * 8) / (mbitPerSec * 1_000_000) / 3_600;
}

export interface R2CostEstimate {
  gigabytes: number;
  /** Storage for one month, after the free 10 GB-month. */
  storageUsdPerMonth: number;
  /** Uploads: one PutObject (Class A) per file, since every accepted file is 200 MiB or less
   * (rclone's default --s3-upload-cutoff is 200Mi, so no multipart parts). */
  uploadUsd: number;
}

export function r2Cost(bytes: number, files: number): R2CostEstimate {
  const gigabytes = bytes / 1e9;
  const storage = Math.max(0, gigabytes - R2_PRICING.freeGbMonth) * R2_PRICING.usdPerGbMonth;
  const classA =
    (Math.max(0, files - R2_PRICING.freeClassAPerMonth) / 1_000_000) *
    R2_PRICING.classAUsdPerMillion;
  return { gigabytes, storageUsdPerMonth: storage, uploadUsd: classA };
}

export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`;
}

export function formatHours(hours: number): string {
  if (hours < 1) return plural(Math.max(1, Math.round(hours * 60)), 'minute');
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

export interface ExtensionStat {
  ext: string;
  files: number;
  bytes: number;
}

export interface ScanReport {
  folder: string;
  scannedAt: string;
  totals: { files: number; bytes: number };
  byExtension: ExtensionStat[];
  largest: Array<{ relPath: string; bytes: number }>;
  rejected: Array<{ relPath: string; bytes: number; reasons: RejectReason[] }>;
  rejectedByReason: Partial<Record<RejectReason, number>>;
  nameWarnings: Array<{ relPath: string; warnings: string[] }>;
  duplicates: { groups: string[][]; extraCopies: number; extraBytes: number };
  skipped: FolderScan['skipped'];
  hashErrors: FolderScan['hashErrors'];
  upload: {
    files: number;
    bytes: number;
    skipDuplicates: boolean;
    hours: UploadEstimate[];
    r2: R2CostEstimate & { pricing: typeof R2_PRICING };
  };
}

function byExtension(verdicts: readonly FileVerdict[]): ExtensionStat[] {
  const map = new Map<string, ExtensionStat>();
  for (const v of verdicts) {
    const ext = v.ext || '(none)';
    const stat = map.get(ext) ?? { ext, files: 0, bytes: 0 };
    map.set(ext, { ext, files: stat.files + 1, bytes: stat.bytes + v.size });
  }
  return [...map.values()].sort((a, b) => b.files - a.files || a.ext.localeCompare(b.ext));
}

export function buildScanReport(
  scan: FolderScan,
  upload: readonly FileVerdict[],
  options: { skipDuplicates: boolean; largest?: number; now?: Date },
): ScanReport {
  const sizeOf = new Map(scan.verdicts.map((v) => [v.relPath, v.size]));
  const rejected = scan.verdicts.filter((v) => v.reject.length > 0);
  const rejectedByReason: Partial<Record<RejectReason, number>> = {};
  for (const v of rejected)
    for (const r of v.reject) rejectedByReason[r] = (rejectedByReason[r] ?? 0) + 1;
  const extras = scan.duplicates.flatMap((g) => g.slice(1));
  const uploadBytes = upload.reduce((sum, f) => sum + f.size, 0);
  return {
    folder: scan.root,
    scannedAt: (options.now ?? new Date()).toISOString(),
    totals: {
      files: scan.verdicts.length,
      bytes: scan.verdicts.reduce((sum, v) => sum + v.size, 0),
    },
    byExtension: byExtension(scan.verdicts),
    largest: [...scan.verdicts]
      .sort((a, b) => b.size - a.size || a.relPath.localeCompare(b.relPath))
      .slice(0, options.largest ?? 10)
      .map((v) => ({ relPath: v.relPath, bytes: v.size })),
    rejected: rejected.map((v) => ({ relPath: v.relPath, bytes: v.size, reasons: v.reject })),
    rejectedByReason,
    nameWarnings: scan.verdicts
      .filter((v) => v.warnings.length > 0 && v.reject.length === 0)
      .map((v) => ({ relPath: v.relPath, warnings: v.warnings })),
    duplicates: {
      groups: scan.duplicates,
      extraCopies: extras.length,
      extraBytes: extras.reduce((sum, p) => sum + (sizeOf.get(p) ?? 0), 0),
    },
    skipped: scan.skipped,
    hashErrors: scan.hashErrors,
    upload: {
      files: upload.length,
      bytes: uploadBytes,
      skipDuplicates: options.skipDuplicates,
      hours: UPLOAD_SPEEDS_MBIT.map((m) => ({ mbitPerSec: m, hours: uploadHours(uploadBytes, m) })),
      r2: { ...r2Cost(uploadBytes, upload.length), pricing: R2_PRICING },
    },
  };
}

function listSome<T>(items: readonly T[], show: (item: T) => string, limit: number): string[] {
  const lines = items.slice(0, limit).map((i) => `    - ${show(i)}`);
  if (items.length > limit)
    lines.push(`    … and ${items.length - limit} more (see the JSON report)`);
  return lines;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The plain-English summary printed by scan-folder. */
export function formatScanSummary(report: ScanReport, limit = 15): string {
  const r = report;
  const lines = [
    `Folder: ${r.folder}`,
    `Found ${plural(r.totals.files, 'file')}, ${formatBytes(r.totals.bytes)} in total.`,
    '',
    'By type:',
    ...r.byExtension.map(
      (e) => `    .${e.ext}: ${plural(e.files, 'file')}, ${formatBytes(e.bytes)}`,
    ),
    '',
    'Largest files:',
    ...r.largest.map((f) => `    ${formatBytes(f.bytes)}  ${f.relPath}`),
    '',
  ];
  if (r.rejected.length === 0) lines.push('Files Studio would refuse: none.');
  else {
    lines.push(
      `Files Studio would refuse (${r.rejected.length}); they are left out of the upload:`,
    );
    for (const [reason, count] of Object.entries(r.rejectedByReason))
      lines.push(`  ${count} × ${REJECT_EXPLANATION[reason as RejectReason]}`);
    lines.push(...listSome(r.rejected, (f) => `${f.relPath} (${f.reasons.join(', ')})`, limit));
  }
  lines.push('');
  if (r.duplicates.groups.length === 0) lines.push('Duplicate videos: none found.');
  else {
    lines.push(
      `Duplicate videos: ${plural(r.duplicates.groups.length, 'set')}, ${r.duplicates.extraCopies} extra ${r.duplicates.extraCopies === 1 ? 'copy' : 'copies'} (${formatBytes(r.duplicates.extraBytes)}).`,
      r.upload.skipDuplicates
        ? '  Only the first copy of each set is uploaded (--skip-duplicates).'
        : '  All copies are uploaded; Studio stores the content once. Add --skip-duplicates to upload one copy.',
      ...listSome(r.duplicates.groups, (g) => g.join('  =  '), limit),
    );
  }
  if (r.nameWarnings.length > 0)
    lines.push(
      '',
      `Names worth a look (${r.nameWarnings.length}; they still upload):`,
      ...listSome(r.nameWarnings, (w) => `${w.relPath} (${w.warnings.join('; ')})`, limit),
    );
  if (r.skipped.length > 0 || r.hashErrors.length > 0)
    lines.push(
      '',
      `Not looked at (${r.skipped.length + r.hashErrors.length}):`,
      ...listSome([...r.skipped, ...r.hashErrors], (s) => `${s.relPath}: ${s.reason}`, limit),
    );
  const u = r.upload;
  lines.push(
    '',
    `To upload: ${u.files} videos, ${formatBytes(u.bytes)}.`,
    'Upload time at full line speed (real uploads are usually 10–30% slower):',
    ...u.hours.map((h) => `    ${h.mbitPerSec} Mbit/s: about ${formatHours(h.hours)}`),
    `Cloudflare R2 cost: about ${usd(u.r2.storageUsdPerMonth)} a month to store ${u.r2.gigabytes.toFixed(1)} GB` +
      ` ($${R2_PRICING.usdPerGbMonth} per GB-month after the free ${R2_PRICING.freeGbMonth} GB),` +
      ` plus ${usd(u.r2.uploadUsd)} for the uploads (first ${R2_PRICING.freeClassAPerMonth.toLocaleString('en-GB')} a month free). Downloads are free.`,
    `  Prices from ${R2_PRICING.source}, read ${R2_PRICING.readOn}. Delete the bucket after the ingest to stop the storage charge.`,
  );
  return lines.join('\n');
}
