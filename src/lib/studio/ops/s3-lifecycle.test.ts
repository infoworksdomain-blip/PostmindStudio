import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import {
  awsRuleProblems,
  diffBucket,
  formatDiff,
  isNoop,
  parseLifecycleFile,
  validateLifecycleFile,
  type LifecycleRule,
} from './s3-lifecycle';

// BACKLOG 14.2 — CI check (npm test, verify job) that infra/s3-lifecycle.json is valid for AWS and
// matches Studio's retention policy, plus the validator's own behaviour and the dry-run diff.

const FILE = join(process.cwd(), 'infra', 's3-lifecycle.json');
const committed = (): unknown => JSON.parse(readFileSync(FILE, 'utf8'));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('infra/s3-lifecycle.json', () => {
  it('is valid: AWS rule constraints and the Studio retention policy', () => {
    expect(validateLifecycleFile(committed()).problems).toEqual([]);
    const file = parseLifecycleFile(committed());
    expect(Object.keys(file.buckets).sort()).toEqual([
      'assets',
      'library',
      'renders',
      'thumbnails',
    ]);
  });

  it('never expires current objects under orgs/ except tagged provider outputs', () => {
    const file = parseLifecycleFile(committed());
    for (const entry of Object.values(file.buckets)) {
      for (const rule of entry?.rules ?? []) {
        if (rule.Expiration?.Days === undefined) continue;
        const tagged = rule.Filter.Tag?.Value === 'provider-output';
        expect(tagged || rule.Filter.Prefix === 'library/staging/', rule.ID).toBe(true);
      }
    }
  });
});

describe('validateLifecycleFile', () => {
  const mutate = (fn: (f: { buckets: Record<string, { rules: LifecycleRule[] }> }) => void) => {
    const f = clone(committed()) as { buckets: Record<string, { rules: LifecycleRule[] }> };
    fn(f);
    return validateLifecycleFile(f).problems;
  };

  it('rejects a blanket expiry of the uploads prefix', () => {
    const problems = mutate((f) =>
      f.buckets.assets?.rules.push({
        ID: 'studio-uploads-expire',
        Status: 'Enabled',
        Filter: { Prefix: 'orgs/' },
        Expiration: { Days: 7 },
      }),
    );
    expect(problems.join('\n')).toMatch(/must not expire current objects under orgs\//);
  });

  it('rejects any current-object expiry on the renders bucket', () => {
    const problems = mutate((f) =>
      f.buckets.renders?.rules.push({
        ID: 'studio-renders-expire',
        Status: 'Enabled',
        Filter: { Prefix: 'tmp/' },
        Expiration: { Days: 90 },
      }),
    );
    expect(problems.join('\n')).toMatch(/renders are kept/);
  });

  it('requires the policy rules and studio- rule IDs', () => {
    expect(mutate((f) => f.buckets.library?.rules.splice(0, 1)).join('\n')).toMatch(
      /library\/staging\/ expires after 2 days/,
    );
    expect(mutate((f) => f.buckets.assets?.rules.splice(0, 1)).join('\n')).toMatch(/intermediates/);
    expect(
      mutate((f) => {
        const rule = f.buckets.thumbnails?.rules[0];
        if (rule) rule.ID = 'other-rule';
      }).join('\n'),
    ).toMatch(/must start with "studio-"/);
    expect(
      mutate((f) =>
        f.buckets.renders?.rules.push(clone(f.buckets.renders.rules[0] as LifecycleRule)),
      ),
    ).toContain('renders: duplicate rule IDs');
  });

  it('reports schema errors (unknown keys, bad status)', () => {
    const problems = mutate((f) => {
      const rule = f.buckets.assets?.rules[0] as unknown as Record<string, unknown>;
      rule.Status = 'On';
      rule.Transitionz = [];
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(() => parseLifecycleFile({ buckets: {} })).toThrow(ValidationError);
  });
});

describe('awsRuleProblems', () => {
  const base = { ID: 'studio-x', Status: 'Enabled' as const };
  it('enforces one filter element and one expiration form', () => {
    expect(awsRuleProblems({ ...base, Filter: {}, Expiration: { Days: 1 } })).toContain(
      'Filter must have exactly one of Prefix, Tag, ObjectSize*, And',
    );
    expect(
      awsRuleProblems({
        ...base,
        Filter: { Prefix: '' },
        Expiration: { Days: 1, ExpiredObjectDeleteMarker: true },
      }),
    ).toContain('Expiration must have exactly one of Days, Date, ExpiredObjectDeleteMarker');
    expect(awsRuleProblems({ ...base, Filter: { Prefix: 'a/' } })).toContain('rule has no action');
  });

  it('refuses multipart abort and delete-marker cleanup with a tag filter (AWS limits)', () => {
    const tagged = { ...base, Filter: { Tag: { Key: 'k', Value: 'v' } } };
    expect(
      awsRuleProblems({ ...tagged, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } }),
    ).toContain('AbortIncompleteMultipartUpload cannot be used with a tag filter');
    expect(
      awsRuleProblems({ ...tagged, Expiration: { ExpiredObjectDeleteMarker: true } }),
    ).toContain('ExpiredObjectDeleteMarker cannot be used with a tag filter');
  });
});

describe('diffBucket', () => {
  const desired = parseLifecycleFile(committed()).buckets.renders?.rules ?? [];

  it('adds everything to a bucket with no configuration', () => {
    const diff = diffBucket([], desired);
    expect(diff.added).toEqual(desired.map((r) => r.ID));
    expect(diff.next).toEqual(desired);
    expect(formatDiff('renders', 'studio-renders-prod', diff)).toContain('+ studio-abort');
  });

  it('is a no-op when S3 already has the rules (Filter {} equals Prefix "")', () => {
    const current = desired.map((r) => (r.Filter.Prefix === '' ? { ...r, Filter: {} } : r));
    const diff = diffBucket(current, desired);
    expect(isNoop(diff)).toBe(true);
    expect(formatDiff('renders', 'b', diff)).toContain('no changes');
  });

  it('keeps rules Studio does not manage and removes stale studio- rules', () => {
    const foreign = { ID: 'backup-team-rule', Status: 'Enabled', Filter: { Prefix: 'x/' } };
    const stale = { ID: 'studio-old', Status: 'Enabled', Filter: { Prefix: 'y/' } };
    const changed = { ...desired[0], NoncurrentVersionExpiration: { NoncurrentDays: 90 } };
    const diff = diffBucket([foreign, stale, changed], desired);
    expect(diff.kept).toEqual(['backup-team-rule']);
    expect(diff.removed).toEqual(['studio-old']);
    expect(diff.changed).toEqual([desired[0]?.ID]);
    expect(diff.next).toEqual([...desired, foreign]);
  });
});
