import { describe, expect, it } from 'vitest';
import { ConfigurationError, ValidationError } from '../../errors';
import {
  assertAllowedS3Source,
  isS3Url,
  isSupportedSourceUrl,
  parseCorpusBuckets,
  parseS3Url,
} from './corpus-source';

describe('parseS3Url', () => {
  it('splits bucket and key', () => {
    expect(parseS3Url('s3://postmind-corpus/2026/a b.mp4')).toEqual({
      bucket: 'postmind-corpus',
      key: '2026/a b.mp4',
    });
    expect(isS3Url('s3://x/y')).toBe(true);
    expect(isS3Url('https://x/y')).toBe(false);
  });

  it.each([
    ['s3://bucket', 's3://bucket/key'],
    ['s3:///key', 's3://bucket/key'],
    ['s3://UPPER/key', 'bucket name'],
    ['s3://ab/key', 'bucket name'],
    ['s3://bucket/../secret', '. or ..'],
    ['s3://bucket/a/./b', '. or ..'],
    ['s3://bucket/a\u0000b', 'control'],
  ])('rejects %s', (raw, message) => {
    expect(() => parseS3Url(raw)).toThrow(message);
  });
});

describe('isSupportedSourceUrl', () => {
  it('accepts http(s) and well-formed s3 only', () => {
    expect(isSupportedSourceUrl('https://cdn.example/a.mp4')).toBe(true);
    expect(isSupportedSourceUrl('http://cdn.example/a.mp4')).toBe(true);
    expect(isSupportedSourceUrl('s3://corpus/a.mp4')).toBe(true);
    expect(isSupportedSourceUrl('s3://corpus')).toBe(false);
    expect(isSupportedSourceUrl('file:///etc/passwd')).toBe(false);
    expect(isSupportedSourceUrl('gopher://x')).toBe(false);
    expect(isSupportedSourceUrl('not a url')).toBe(false);
  });
});

describe('STUDIO_CORPUS_S3_BUCKETS allow-list', () => {
  it('parses buckets and bucket/prefix entries', () => {
    expect(parseCorpusBuckets(undefined)).toEqual([]);
    expect(parseCorpusBuckets(' postmind-corpus , studio-library-assets/corpus/ ')).toEqual([
      { bucket: 'postmind-corpus', prefix: '' },
      { bucket: 'studio-library-assets', prefix: 'corpus/' },
    ]);
  });

  it('fails loudly on a malformed entry', () => {
    expect(() => parseCorpusBuckets('Bad_Bucket')).toThrow(ConfigurationError);
    expect(() => parseCorpusBuckets('bucket/../x')).toThrow(ConfigurationError);
  });

  it('allows only listed buckets and prefixes', () => {
    const allowed = parseCorpusBuckets('postmind-corpus,studio-library-assets/corpus/');
    expect(() =>
      assertAllowedS3Source({ bucket: 'postmind-corpus', key: 'any/a.mp4' }, allowed),
    ).not.toThrow();
    expect(() =>
      assertAllowedS3Source({ bucket: 'studio-library-assets', key: 'corpus/a.mp4' }, allowed),
    ).not.toThrow();
    expect(() =>
      assertAllowedS3Source({ bucket: 'studio-library-assets', key: 'library/x.mp4' }, allowed),
    ).toThrow('not in STUDIO_CORPUS_S3_BUCKETS');
    expect(() => assertAllowedS3Source({ bucket: 'other', key: 'a.mp4' }, allowed)).toThrow(
      ValidationError,
    );
    expect(() => assertAllowedS3Source({ bucket: 'postmind-corpus', key: 'a' }, [])).toThrow(
      's3:// sources are disabled',
    );
  });

  it('does not let a sibling key bypass a prefix via a startsWith collision', () => {
    // "corpus" (no trailing slash) must not also allow "corpus-evil/secret.mp4".
    const allowed = parseCorpusBuckets('studio-library-assets/corpus');
    expect(() =>
      assertAllowedS3Source({ bucket: 'studio-library-assets', key: 'corpus/a.mp4' }, allowed),
    ).not.toThrow();
    expect(() =>
      assertAllowedS3Source({ bucket: 'studio-library-assets', key: 'corpus' }, allowed),
    ).not.toThrow();
    expect(() =>
      assertAllowedS3Source(
        { bucket: 'studio-library-assets', key: 'corpus-evil/secret.mp4' },
        allowed,
      ),
    ).toThrow('not in STUDIO_CORPUS_S3_BUCKETS');
  });
});
