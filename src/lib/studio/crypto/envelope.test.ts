import { randomBytes } from 'node:crypto';
import { KMSClient } from '@aws-sdk/client-kms';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError, ValidationError } from '../../errors';
import {
  createKmsKeyProvider,
  createLocalKeyProvider,
  decryptSecret,
  encryptSecret,
  tokenContext,
} from './envelope';

afterEach(() => vi.restoreAllMocks());

const masterKey = randomBytes(32).toString('base64');
const provider = createLocalKeyProvider(masterKey, 'test');
const context = tokenContext({ organisationId: 'org-1', platform: 'tiktok', kind: 'access' });

describe('envelope encryption', () => {
  it('round-trips a secret and never stores it in plaintext', async () => {
    const sealed = await encryptSecret(provider, 'act.example-token', context);
    expect(sealed).toMatch(/^v1\.local\.[\w-]+\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain('example-token');
    await expect(decryptSecret(provider, sealed, context)).resolves.toBe('act.example-token');
  });

  it('uses a fresh data key and IV per secret', async () => {
    const a = await encryptSecret(provider, 'same', context);
    const b = await encryptSecret(provider, 'same', context);
    expect(a).not.toBe(b);
  });

  it('binds the ciphertext to its encryption context (another org cannot decrypt)', async () => {
    const sealed = await encryptSecret(provider, 'secret', context);
    const otherOrg = tokenContext({ organisationId: 'org-2', platform: 'tiktok', kind: 'access' });
    await expect(decryptSecret(provider, sealed, otherOrg)).rejects.toThrow();
  });

  it('detects tampering', async () => {
    const sealed = await encryptSecret(provider, 'secret', context);
    const parts = sealed.split('.');
    const body = Buffer.from(parts[5]!, 'base64url');
    body[0] = body[0]! ^ 0xff;
    parts[5] = body.toString('base64url');
    await expect(decryptSecret(provider, parts.join('.'), context)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(decryptSecret(provider, 'garbage', context)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('refuses envelopes from another key provider', async () => {
    const sealed = await encryptSecret(provider, 'secret', context);
    const other = { ...provider, id: 'kms' };
    await expect(decryptSecret(other, sealed, context)).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('context key order does not matter', async () => {
    const sealed = await encryptSecret(provider, 'x', { a: '1', b: '2' });
    await expect(decryptSecret(provider, sealed, { b: '2', a: '1' })).resolves.toBe('x');
  });
});

describe('local key provider', () => {
  it('is refused in production and validates the master key', () => {
    expect(() => createLocalKeyProvider(masterKey, 'production')).toThrow(ConfigurationError);
    expect(() => createLocalKeyProvider(Buffer.from('short').toString('base64'), 'test')).toThrow(
      ConfigurationError,
    );
  });
});

describe('KMS key provider', () => {
  it('requests AES_256 data keys with the encryption context and decrypts with it', async () => {
    const client = new KMSClient({
      region: 'eu-west-2',
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
    });
    const plaintext = new Uint8Array(randomBytes(32));
    const send = vi
      .spyOn(client, 'send')
      .mockResolvedValueOnce({
        Plaintext: new Uint8Array(plaintext),
        CiphertextBlob: new Uint8Array([9, 9]),
      } as never)
      .mockResolvedValueOnce({ Plaintext: new Uint8Array(plaintext) } as never);
    const kms = createKmsKeyProvider(client, 'alias/studio');
    const sealed = await encryptSecret(kms, 'token', context);
    await expect(decryptSecret(kms, sealed, context)).resolves.toBe('token');
    const [generate, decrypt] = send.mock.calls.map(
      (c) => (c[0] as unknown as { input: Record<string, unknown> }).input,
    );
    expect(generate).toEqual({
      KeyId: 'alias/studio',
      KeySpec: 'AES_256',
      EncryptionContext: context,
    });
    expect(decrypt).toMatchObject({ KeyId: 'alias/studio', EncryptionContext: context });
  });

  it('fails clearly when KMS returns nothing', async () => {
    const client = new KMSClient({
      region: 'eu-west-2',
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
    });
    vi.spyOn(client, 'send').mockResolvedValue({} as never);
    await expect(
      encryptSecret(createKmsKeyProvider(client, 'k'), 'x', context),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});
