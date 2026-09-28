import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError, ValidationError } from '../errors';
import { assetsBucket, createS3Storage, objectTaggingFor, providerOutputKey } from './storage';

afterEach(() => vi.unstubAllEnvs());

describe('providerOutputKey', () => {
  it('scopes keys by organisation, project and provider', () => {
    expect(
      providerOutputKey({
        organisationId: 'o',
        projectId: 'p',
        providerId: 'openai',
        extension: 'png',
        id: 'x',
      }),
    ).toBe('orgs/o/projects/p/providers/openai/x.png');
    expect(
      providerOutputKey({ organisationId: 'o', providerId: 'openai', extension: 'png', id: 'x' }),
    ).toContain('/no-project/');
  });
});

describe('createS3Storage', () => {
  it('puts the object and returns a presigned GET URL', async () => {
    // Presigning is local; no network. Static test credentials only.
    const client = new S3Client({
      region: 'eu-west-2',
      credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret' },
    });
    const send = vi.spyOn(client, 'send').mockResolvedValue({} as never);
    const stored = await createS3Storage(client).put({
      bucket: 'studio-assets-dev',
      key: 'orgs/o/x.png',
      body: new Uint8Array([1]),
      contentType: 'image/png',
    });
    const command = send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'studio-assets-dev',
      Key: 'orgs/o/x.png',
      ContentType: 'image/png',
    });
    expect(stored.url).toMatch(
      /^https:\/\/studio-assets-dev\.s3\.eu-west-2\.amazonaws\.com\/orgs\/o\/x\.png\?.*X-Amz-Expires=86400/,
    );
  });
});

describe('assetsBucket', () => {
  it('requires S3_BUCKET_ASSETS', () => {
    vi.stubEnv('S3_BUCKET_ASSETS', '');
    expect(() => assetsBucket()).toThrow(ConfigurationError);
    vi.stubEnv('S3_BUCKET_ASSETS', 'studio-assets-dev');
    expect(assetsBucket()).toBe('studio-assets-dev');
  });
});

describe('providerOutputKey safety', () => {
  it.each([
    { organisationId: '../other-org' },
    { organisationId: 'org/../../x' },
    { projectId: '..' },
    { projectId: '.hidden' },
    { providerId: 'a b' },
    { extension: 'png/x' },
    { id: '' },
  ])('rejects unsafe segment %o', (patch) => {
    expect(() =>
      providerOutputKey({
        organisationId: 'o',
        providerId: 'openai',
        extension: 'png',
        id: 'x',
        ...patch,
      }),
    ).toThrow(ValidationError);
  });

  it('accepts cuid, uuid and provider ids', () => {
    expect(
      providerOutputKey({
        organisationId: 'clx9k2b3c0000abcd',
        projectId: '6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f',
        providerId: 'd-id',
        extension: 'mp3',
        id: 'x',
      }),
    ).toBe(
      'orgs/clx9k2b3c0000abcd/projects/6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f/providers/d-id/x.mp3',
    );
  });
});

// BACKLOG 14.1 / 14.2
const offlineClient = () =>
  new S3Client({
    region: 'eu-west-2',
    credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret' },
  });

describe('objectTaggingFor (14.2 lifecycle tag)', () => {
  it('tags provider outputs only; uploads, images and consent stay untagged', () => {
    expect(objectTaggingFor('orgs/o/projects/p/providers/runway/x.mp4')).toBe(
      'studio-object=provider-output',
    );
    expect(objectTaggingFor('orgs/o/uploads/u/source.mp4')).toBeUndefined();
    expect(objectTaggingFor('orgs/o/businesses/b/images/f.png')).toBeUndefined();
    expect(objectTaggingFor('orgs/o/voice-consent/c.webm')).toBeUndefined();
    expect(objectTaggingFor('library/staging/x.mp4')).toBeUndefined();
  });

  it('sends the tag on PutObject for provider outputs', async () => {
    const client = offlineClient();
    const send = vi.spyOn(client, 'send').mockResolvedValue({} as never);
    await createS3Storage(client).put({
      bucket: 'assets',
      key: 'orgs/o/projects/p/providers/openai/x.png',
      body: new Uint8Array([1]),
      contentType: 'image/png',
    });
    expect((send.mock.calls[0]?.[0] as PutObjectCommand).input.Tagging).toBe(
      'studio-object=provider-output',
    );
  });
});

describe('list / deleteMany (14.1)', () => {
  it('lists one page under a prefix with the continuation token', async () => {
    const client = offlineClient();
    const send = vi.spyOn(client, 'send').mockResolvedValue({
      Contents: [{ Key: 'orgs/o/a', Size: 3 }, { Key: 'orgs/o/b' }],
      IsTruncated: true,
      NextContinuationToken: 'next',
    } as never);
    const page = await createS3Storage(client).list?.('assets', 'orgs/o/', 'tok');
    const command = send.mock.calls[0]?.[0] as ListObjectsV2Command;
    expect(command).toBeInstanceOf(ListObjectsV2Command);
    expect(command.input).toEqual({
      Bucket: 'assets',
      Prefix: 'orgs/o/',
      ContinuationToken: 'tok',
      MaxKeys: 1000,
    });
    expect(page).toEqual({
      objects: [
        { key: 'orgs/o/a', size: 3 },
        { key: 'orgs/o/b', size: 0 },
      ],
      nextToken: 'next',
    });
  });

  it('refuses to list a whole bucket', async () => {
    await expect(createS3Storage(offlineClient()).list?.('assets', '')).rejects.toThrow(
      ValidationError,
    );
  });

  it('batch-deletes quietly and returns the keys S3 refused', async () => {
    const client = offlineClient();
    const send = vi.spyOn(client, 'send').mockResolvedValue({
      Errors: [{ Key: 'k2', Code: 'AccessDenied', Message: 'Access Denied' }],
    } as never);
    const out = await createS3Storage(client).deleteMany?.('assets', ['k1', 'k2']);
    const command = send.mock.calls[0]?.[0] as DeleteObjectsCommand;
    expect(command).toBeInstanceOf(DeleteObjectsCommand);
    expect(command.input).toEqual({
      Bucket: 'assets',
      Delete: { Objects: [{ Key: 'k1' }, { Key: 'k2' }], Quiet: true },
    });
    expect(out).toEqual({
      deleted: 1,
      errors: [{ key: 'k2', code: 'AccessDenied', message: 'Access Denied' }],
    });
  });

  it('refuses more than 1,000 keys and sends nothing for none', async () => {
    const client = offlineClient();
    const send = vi.spyOn(client, 'send');
    const storage = createS3Storage(client);
    await expect(
      storage.deleteMany?.(
        'assets',
        Array.from({ length: 1001 }, (_, i) => String(i)),
      ),
    ).rejects.toThrow(ValidationError);
    expect(await storage.deleteMany?.('assets', [])).toEqual({ deleted: 0, errors: [] });
    expect(send).not.toHaveBeenCalled();
  });
});
