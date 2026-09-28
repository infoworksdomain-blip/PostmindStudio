import { z } from 'zod';
import { ValidationError } from '../../errors';

// BACKLOG 14.2 — infra/s3-lifecycle.json: schema, AWS rule constraints, Studio's retention
// policy, and the dry-run diff for scripts/ops/apply-s3-lifecycle.ts. Pure (no I/O) so CI runs it
// in `npm test`. AWS constraints encoded here (read 2026-09-28):
//   - LifecycleRule: ID ≤ 255 chars; Status Enabled | Disabled; Filter has exactly one of
//     Prefix, Tag, ObjectSizeGreaterThan, ObjectSizeLessThan, And
//     https://docs.aws.amazon.com/AmazonS3/latest/API/API_LifecycleRule.html
//   - LifecycleExpiration: Days, Date or ExpiredObjectDeleteMarker (one of them)
//     https://docs.aws.amazon.com/AmazonS3/latest/API/API_LifecycleExpiration.html
//   - AbortIncompleteMultipartUpload and ExpiredObjectDeleteMarker cannot be used in a rule
//     whose filter uses object tags; at most 1,000 rules per bucket
//     https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html

export const MANAGED_RULE_PREFIX = 'studio-';
export const MAX_RULES_PER_BUCKET = 1_000;
export const LOGICAL_BUCKETS = ['assets', 'renders', 'thumbnails', 'library'] as const;
export type LogicalBucket = (typeof LOGICAL_BUCKETS)[number];

const days = z.number().int().positive();
const tag = z.object({ Key: z.string().min(1).max(128), Value: z.string().max(256) }).strict();

const filterSchema = z
  .object({
    Prefix: z.string().max(1024).optional(),
    Tag: tag.optional(),
    ObjectSizeGreaterThan: z.number().int().nonnegative().optional(),
    ObjectSizeLessThan: z.number().int().positive().optional(),
    And: z
      .object({
        Prefix: z.string().max(1024).optional(),
        Tags: z.array(tag).optional(),
        ObjectSizeGreaterThan: z.number().int().nonnegative().optional(),
        ObjectSizeLessThan: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const lifecycleRuleSchema = z
  .object({
    ID: z.string().min(1).max(255),
    Status: z.enum(['Enabled', 'Disabled']),
    Filter: filterSchema,
    Expiration: z
      .object({
        Days: days.optional(),
        Date: z.string().optional(),
        ExpiredObjectDeleteMarker: z.boolean().optional(),
      })
      .strict()
      .optional(),
    NoncurrentVersionExpiration: z
      .object({
        NoncurrentDays: days,
        NewerNoncurrentVersions: z.number().int().min(1).max(100).optional(),
      })
      .strict()
      .optional(),
    AbortIncompleteMultipartUpload: z.object({ DaysAfterInitiation: days }).strict().optional(),
  })
  .strict();

export type LifecycleRule = z.infer<typeof lifecycleRuleSchema>;

export const lifecycleFileSchema = z
  .object({
    $comment: z.array(z.string()).optional(),
    buckets: z.record(
      z.enum(LOGICAL_BUCKETS),
      z
        .object({
          envVar: z.string().regex(/^S3_BUCKET_[A-Z]+$/),
          rules: z.array(lifecycleRuleSchema),
        })
        .strict(),
    ),
  })
  .strict();

export type LifecycleFile = z.infer<typeof lifecycleFileSchema>;

const hasTagFilter = (r: LifecycleRule) => Boolean(r.Filter.Tag || r.Filter.And?.Tags?.length);
const prefixOf = (r: LifecycleRule) => r.Filter.Prefix ?? r.Filter.And?.Prefix ?? '';
/** True when the rule's prefix can match keys under orgs/ (''/'o'/'orgs/' or 'orgs/x/'). */
const reachesOrgs = (r: LifecycleRule) => {
  const p = prefixOf(r);
  return 'orgs/'.startsWith(p) || p.startsWith('orgs/');
};

/** AWS's own rule constraints. */
export function awsRuleProblems(rule: LifecycleRule): string[] {
  const out: string[] = [];
  const f = rule.Filter;
  const set = [
    f.Prefix !== undefined,
    f.Tag,
    f.ObjectSizeGreaterThan !== undefined,
    f.ObjectSizeLessThan !== undefined,
    f.And,
  ].filter(Boolean);
  if (set.length !== 1) out.push('Filter must have exactly one of Prefix, Tag, ObjectSize*, And');
  const e = rule.Expiration;
  if (e) {
    const actions = [
      e.Days !== undefined,
      e.Date !== undefined,
      e.ExpiredObjectDeleteMarker !== undefined,
    ].filter(Boolean);
    if (actions.length !== 1)
      out.push('Expiration must have exactly one of Days, Date, ExpiredObjectDeleteMarker');
  }
  if (!e && !rule.NoncurrentVersionExpiration && !rule.AbortIncompleteMultipartUpload) {
    out.push('rule has no action');
  }
  if (hasTagFilter(rule) && rule.AbortIncompleteMultipartUpload) {
    out.push('AbortIncompleteMultipartUpload cannot be used with a tag filter');
  }
  if (hasTagFilter(rule) && e?.ExpiredObjectDeleteMarker !== undefined) {
    out.push('ExpiredObjectDeleteMarker cannot be used with a tag filter');
  }
  return out;
}

/** Studio's retention policy (spec 17.4, runbooks/storage-cost.md + deploy.md). */
export function policyProblems(bucket: LogicalBucket, rules: LifecycleRule[]): string[] {
  const out: string[] = [];
  const enabled = rules.filter((r) => r.Status === 'Enabled');
  for (const r of rules) {
    if (!r.ID.startsWith(MANAGED_RULE_PREFIX))
      out.push(`${r.ID}: rule IDs must start with "${MANAGED_RULE_PREFIX}"`);
    const expiresCurrent = r.Expiration?.Days !== undefined || r.Expiration?.Date !== undefined;
    if (expiresCurrent && reachesOrgs(r) && !hasTagFilter(r)) {
      out.push(
        `${r.ID}: must not expire current objects under orgs/ by prefix (completed uploads, images, consent, renders)`,
      );
    }
    if (bucket === 'renders' && expiresCurrent) {
      out.push(
        `${r.ID}: renders are kept for the publication's lifetime + 90 days (app logic), never expired by lifecycle`,
      );
    }
  }
  const has = (pred: (r: LifecycleRule) => boolean, what: string) => {
    if (!enabled.some(pred)) out.push(`missing an enabled rule: ${what}`);
  };
  has(
    (r) =>
      r.NoncurrentVersionExpiration?.NoncurrentDays === 30 &&
      prefixOf(r) === '' &&
      !hasTagFilter(r),
    'noncurrent versions expire after 30 days (whole bucket)',
  );
  has(
    (r) => r.AbortIncompleteMultipartUpload?.DaysAfterInitiation === 7 && prefixOf(r) === '',
    'abort incomplete multipart uploads after 7 days (whole bucket)',
  );
  if (bucket === 'assets') {
    has(
      (r) =>
        r.Expiration?.Days === 30 &&
        r.Filter.Tag?.Key === 'studio-object' &&
        r.Filter.Tag.Value === 'provider-output',
      'intermediates (tag studio-object=provider-output) expire after 30 days',
    );
  }
  if (bucket === 'library') {
    has(
      (r) => r.Expiration?.Days === 2 && prefixOf(r) === 'library/staging/',
      'library/staging/ expires after 2 days',
    );
  }
  return out;
}

/** Every problem with the file; empty = valid. */
export function validateLifecycleFile(raw: unknown): { file?: LifecycleFile; problems: string[] } {
  const parsed = lifecycleFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const problems: string[] = [];
  for (const bucket of LOGICAL_BUCKETS) {
    const entry = parsed.data.buckets[bucket];
    if (!entry) {
      problems.push(`${bucket}: missing`);
      continue;
    }
    const ids = entry.rules.map((r) => r.ID);
    if (new Set(ids).size !== ids.length) problems.push(`${bucket}: duplicate rule IDs`);
    if (entry.rules.length > MAX_RULES_PER_BUCKET)
      problems.push(`${bucket}: more than ${MAX_RULES_PER_BUCKET} rules`);
    for (const rule of entry.rules)
      for (const p of awsRuleProblems(rule)) problems.push(`${bucket}/${rule.ID}: ${p}`);
    for (const p of policyProblems(bucket, entry.rules)) problems.push(`${bucket}: ${p}`);
  }
  return { file: parsed.data, problems };
}

export function parseLifecycleFile(raw: unknown): LifecycleFile {
  const { file, problems } = validateLifecycleFile(raw);
  if (!file || problems.length)
    throw new ValidationError('infra/s3-lifecycle.json is invalid', { problems });
  return file;
}

/** Stable JSON (sorted keys, undefined dropped) for comparing rules. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface BucketDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
  /** Rules on the bucket that Studio does not manage (ID not studio-*): kept as they are. */
  kept: string[];
  /** The full rule list to PUT: Studio's rules plus the kept ones. */
  next: unknown[];
}

/**
 * Diff the bucket's current rules against the desired ones. PutBucketLifecycleConfiguration
 * replaces the whole configuration, so rules that are not Studio's are carried over unchanged.
 */
export function diffBucket(current: unknown[], desired: LifecycleRule[]): BucketDiff {
  const idOf = (r: unknown) => String((r as { ID?: unknown }).ID ?? '');
  const kept = current.filter((r) => !idOf(r).startsWith(MANAGED_RULE_PREFIX));
  const managed = new Map(
    current.filter((r) => idOf(r).startsWith(MANAGED_RULE_PREFIX)).map((r) => [idOf(r), r]),
  );
  const diff: BucketDiff = {
    added: [],
    removed: [],
    changed: [],
    unchanged: [],
    kept: kept.map(idOf),
    next: [...desired, ...kept],
  };
  for (const rule of desired) {
    const was = managed.get(rule.ID);
    if (!was) diff.added.push(rule.ID);
    else if (canonical(normaliseRule(was)) === canonical(normaliseRule(rule)))
      diff.unchanged.push(rule.ID);
    else diff.changed.push(rule.ID);
  }
  for (const id of managed.keys()) if (!desired.some((r) => r.ID === id)) diff.removed.push(id);
  return diff;
}

/** S3 returns some fields the file omits (e.g. Filter {} vs { Prefix: '' }); compare like for like. */
function normaliseRule(rule: unknown): unknown {
  const r = { ...(rule as Record<string, unknown>) };
  delete r.Prefix; // deprecated top-level Prefix
  const filter = r.Filter as Record<string, unknown> | undefined;
  if (!filter || Object.keys(filter).length === 0) r.Filter = { Prefix: '' };
  return r;
}

export function isNoop(diff: BucketDiff): boolean {
  return !diff.added.length && !diff.removed.length && !diff.changed.length;
}

export function formatDiff(bucket: string, name: string, diff: BucketDiff): string {
  const lines = [`${bucket} (${name}):`];
  for (const id of diff.added) lines.push(`  + ${id}`);
  for (const id of diff.changed) lines.push(`  ~ ${id}`);
  for (const id of diff.removed) lines.push(`  - ${id}`);
  for (const id of diff.unchanged) lines.push(`  = ${id}`);
  for (const id of diff.kept) lines.push(`  (kept, not managed by Studio) ${id}`);
  if (isNoop(diff)) lines.push('  no changes');
  return lines.join('\n');
}
