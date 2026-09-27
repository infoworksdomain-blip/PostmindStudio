import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { requireEnv } from '../../env';
import { ConfigurationError, ValidationError } from '../../errors';

// Envelope encryption for secrets at rest (platform OAuth tokens, spec 7.12 "envelope-encrypted";
// Engagement handover 9.6 pattern: AES-256-GCM with a KMS-managed data key).
//
// Each secret gets a fresh 256-bit data key. The data key is encrypted by KMS (never stored in
// plaintext); the secret is encrypted locally with AES-256-GCM. The encryption context binds a
// ciphertext to its owner (organisation + purpose): decrypting under a different context fails.
//
// Stored format: v1.<keyProvider>.<b64url encrypted data key>.<b64url iv>.<b64url tag>.<b64url ciphertext>

const VERSION = 'v1';
const IV_BYTES = 12;

export type EncryptionContext = Record<string, string>;

export interface DataKeyProvider {
  readonly id: string;
  generateDataKey(
    context: EncryptionContext,
  ): Promise<{ plaintext: Uint8Array; encrypted: Uint8Array }>;
  decryptDataKey(encrypted: Uint8Array, context: EncryptionContext): Promise<Uint8Array>;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'));

/** AAD for GCM: the encryption context, canonicalised so key order doesn't matter. */
function aad(context: EncryptionContext): Buffer {
  const sorted = Object.keys(context)
    .sort()
    .map((k) => [k, context[k]]);
  return Buffer.from(JSON.stringify(sorted));
}

export async function encryptSecret(
  provider: DataKeyProvider,
  plaintext: string,
  context: EncryptionContext,
): Promise<string> {
  const dataKey = await provider.generateDataKey(context);
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', dataKey.plaintext, iv);
    cipher.setAAD(aad(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      VERSION,
      provider.id,
      b64(dataKey.encrypted),
      b64(iv),
      b64(cipher.getAuthTag()),
      b64(ciphertext),
    ].join('.');
  } finally {
    dataKey.plaintext.fill(0);
  }
}

export async function decryptSecret(
  provider: DataKeyProvider,
  envelope: string,
  context: EncryptionContext,
): Promise<string> {
  const parts = envelope.split('.');
  if (parts.length !== 6 || parts[0] !== VERSION)
    throw new ValidationError('Unrecognised secret envelope');
  const [, providerId, encryptedKey, iv, tag, ciphertext] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (providerId !== provider.id) {
    throw new ConfigurationError(
      `Secret was sealed by key provider "${providerId}", not "${provider.id}"`,
    );
  }
  const key = await provider.decryptDataKey(unb64(encryptedKey), context);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, unb64(iv));
    decipher.setAAD(aad(context));
    decipher.setAuthTag(unb64(tag));
    return Buffer.concat([decipher.update(unb64(ciphertext)), decipher.final()]).toString('utf8');
  } catch {
    throw new ValidationError('Secret failed authentication (wrong key or encryption context)');
  } finally {
    key.fill(0);
  }
}

/** AWS KMS: GenerateDataKey (AES_256) / Decrypt, with the encryption context enforced by KMS. */
export function createKmsKeyProvider(client: KMSClient, keyId: string): DataKeyProvider {
  return {
    id: 'kms',
    async generateDataKey(context) {
      const out = await client.send(
        new GenerateDataKeyCommand({
          KeyId: keyId,
          KeySpec: 'AES_256',
          EncryptionContext: context,
        }),
      );
      if (!out.Plaintext || !out.CiphertextBlob)
        throw new ConfigurationError('KMS returned no data key');
      return { plaintext: out.Plaintext, encrypted: out.CiphertextBlob };
    },
    async decryptDataKey(encrypted, context) {
      const out = await client.send(
        new DecryptCommand({ CiphertextBlob: encrypted, EncryptionContext: context, KeyId: keyId }),
      );
      if (!out.Plaintext) throw new ConfigurationError('KMS returned no plaintext');
      return out.Plaintext;
    },
  };
}

/**
 * Local development only: wraps data keys with a master key from STUDIO_LOCAL_MASTER_KEY
 * (32 bytes, base64). Refuses to run in production.
 */
export function createLocalKeyProvider(
  masterKeyB64: string,
  nodeEnv = process.env.NODE_ENV,
): DataKeyProvider {
  if (nodeEnv === 'production')
    throw new ConfigurationError('Local key provider is not allowed in production; set KMS_KEY_ID');
  const master = Buffer.from(masterKeyB64, 'base64');
  if (master.length !== 32)
    throw new ConfigurationError('STUDIO_LOCAL_MASTER_KEY must be 32 bytes, base64-encoded');
  const wrap = (key: Uint8Array, context: EncryptionContext) => {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', master, iv);
    cipher.setAAD(aad(context));
    const body = Buffer.concat([cipher.update(key), cipher.final()]);
    return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body]));
  };
  return {
    id: 'local',
    async generateDataKey(context) {
      const plaintext = new Uint8Array(randomBytes(32));
      return { plaintext, encrypted: wrap(plaintext, context) };
    },
    async decryptDataKey(encrypted, context) {
      const buf = Buffer.from(encrypted);
      const decipher = createDecipheriv('aes-256-gcm', master, buf.subarray(0, IV_BYTES));
      decipher.setAAD(aad(context));
      decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + 16));
      return new Uint8Array(
        Buffer.concat([decipher.update(buf.subarray(IV_BYTES + 16)), decipher.final()]),
      );
    },
  };
}

/** Resolve the key provider on first use (so processes that never touch secrets need no key config). */
export function lazyDataKeyProvider(
  resolve: () => DataKeyProvider = getDataKeyProvider,
): DataKeyProvider {
  let real: DataKeyProvider | undefined;
  const get = () => (real ??= resolve());
  return {
    get id() {
      return get().id;
    },
    generateDataKey: (context) => get().generateDataKey(context),
    decryptDataKey: (encrypted, context) => get().decryptDataKey(encrypted, context),
  };
}

let provider: DataKeyProvider | undefined;

/** KMS when KMS_KEY_ID is set; otherwise the local provider (non-production only). */
export function getDataKeyProvider(): DataKeyProvider {
  if (provider) return provider;
  const kmsKeyId = process.env.KMS_KEY_ID?.trim();
  provider = kmsKeyId
    ? createKmsKeyProvider(new KMSClient({ region: requireEnv('AWS_REGION') }), kmsKeyId)
    : createLocalKeyProvider(requireEnv('STUDIO_LOCAL_MASTER_KEY'));
  return provider;
}

/** Encryption context for a platform connection token. */
export function tokenContext(input: {
  organisationId: string;
  platform: string;
  kind: 'access' | 'refresh';
}): EncryptionContext {
  return {
    purpose: 'studio.platform_connection',
    organisationId: input.organisationId,
    platform: input.platform,
    kind: input.kind,
  };
}
