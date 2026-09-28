import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import {
  awsRuleProblems,
  diffBucket,
  formatDiff,
  isNoop,
  lifecycleFileFor,
  parseLifecycleFile,
  R2_INTERMEDIATES_PREFIX,
  r2RuleProblems,
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

// Storage: Cloudflare R2 — infra/r2-lifecycle.json (CI: npm test) and the file selection.
const R2_FILE = join(process.cwd(), 'infra', 'r2-lifecycle.json');
const committedR2 = (): unknown => JSON.parse(readFileSync(R2_FILE, 'utf8'));

describe('lifecycleFileFor', () => {
  it('picks the file for STORAGE_PROVIDER', () => {
    expect(lifecycleFileFor('s3')).toBe('infra/s3-lifecycle.json');
    expect(lifecycleFileFor('r2')).toBe('infra/r2-lifecycle.json');
  });
});

describe('infra/r2-lifecycle.json', () => {
  it('is valid for R2 and Studio policy, with every bucket present', () => {
    expect(validateLifecycleFile(committedR2(), 'r2').problems).toEqual([]);
    const file = parseLifecycleFile(committedR2(), 'r2');
    expect(Object.keys(file.buckets).sort()).toEqual([
      'assets',
      'library',
      'renders',
      'thumbnails',
    ]);
  });

  it('has the expected shape: intermediates 30 d, library/staging 2 d, multipart 7 d everywhere', () => {
    const file = parseLifecycleFile(committedR2(), 'r2');
    const rules = (b: 'assets' | 'renders' | 'thumbnails' | 'library') =>
      file.buckets[b]?.rules ?? [];
    expect(rules('assets')).toContainEqual({
      ID: 'studio-intermediates-expire-30d',
      Status: 'Enabled',
      Filter: { Prefix: R2_INTERMEDIATES_PREFIX },
      Expiration: { Days: 30 },
    });
    expect(rules('library')).toContainEqual({
      ID: 'studio-library-staging-expire-2d',
      Status: 'Enabled',
      Filter: { Prefix: 'library/staging/' },
      Expiration: { Days: 2 },
    });
    for (const b of ['assets', 'renders', 'thumbnails', 'library'] as const) {
      expect(rules(b)).toContainEqual({
        ID: 'studio-abort-incomplete-multipart-7d',
        Status: 'Enabled',
        Filter: { Prefix: '' },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
      });
      for (const r of rules(b)) {
        expect(r.Filter.Tag, r.ID).toBeUndefined();
        expect(r.Filter.And, r.ID).toBeUndefined();
        expect(r.NoncurrentVersionExpiration, r.ID).toBeUndefined();
        expect(r.Expiration?.ExpiredObjectDeleteMarker, r.ID).toBeUndefined();
      }
    }
  });

  it('the S3 file is not valid for R2 (tags, versioning) and vice versa', () => {
    const s3OnR2 = validateLifecycleFile(committed(), 'r2').problems.join('\n');
    expect(s3OnR2).toMatch(/cannot filter by tag/);
    expect(s3OnR2).toMatch(/no bucket versioning/);
    expect(validateLifecycleFile(committedR2(), 's3').problems.join('\n')).toMatch(
      /noncurrent versions expire/,
    );
    expect(() => parseLifecycleFile(committed(), 'r2')).toThrow(
      /infra\/r2-lifecycle.json is invalid/,
    );
  });

  it('requires the intermediates rule on assets and refuses it elsewhere', () => {
    const f = clone(committedR2()) as { buckets: Record<string, { rules: LifecycleRule[] }> };
    const intermediates = f.buckets.assets?.rules.shift() as LifecycleRule;
    f.buckets.renders?.rules.push(intermediates);
    const problems = validateLifecycleFile(f, 'r2').problems.join('\n');
    expect(problems).toMatch(
      /assets: missing an enabled rule: intermediates \(prefix intermediates\/\)/,
    );
    expect(problems).toMatch(
      /renders: studio-intermediates-expire-30d: intermediates expire in the assets bucket only/,
    );
  });

  it('still refuses a blanket expiry under orgs/ on R2', () => {
    const f = clone(committedR2()) as { buckets: Record<string, { rules: LifecycleRule[] }> };
    f.buckets.assets?.rules.push({
      ID: 'studio-orgs-expire',
      Status: 'Enabled',
      Filter: { Prefix: 'orgs/' },
      Expiration: { Days: 7 },
    });
    expect(validateLifecycleFile(f, 'r2').problems.join('\n')).toMatch(
      /must not expire current objects under orgs\//,
    );
  });
});

describe('r2RuleProblems', () => {
  it('flags tag, size filters and versioning actions', () => {
    const base = { ID: 'studio-x', Status: 'Enabled' as const };
    expect(r2RuleProblems({ ...base, Filter: { Prefix: 'a/' }, Expiration: { Days: 1 } })).toEqual(
      [],
    );
    expect(
      r2RuleProblems({
        ...base,
        Filter: { Tag: { Key: 'k', Value: 'v' } },
        Expiration: { Days: 1 },
      }),
    ).toContain('R2 lifecycle rules cannot filter by tag');
    expect(
      r2RuleProblems({ ...base, Filter: { ObjectSizeGreaterThan: 1 }, Expiration: { Days: 1 } }),
    ).toContain('R2 lifecycle rules filter by prefix only');
  });
});
