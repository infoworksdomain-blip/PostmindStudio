import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError, ValidationError } from '../errors';
import { assetsBucket, createS3Storage, providerOutputKey } from './storage';

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
