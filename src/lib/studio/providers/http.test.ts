import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../errors';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { httpJson } from './http';

// Security regression coverage: httpJson must not buffer an unbounded response body into memory
// (BACKLOG 13.32 follow-up security review). A misbehaving or compromised provider host sending an
// oversized body — with or without a (correct) content-length header — must fail fast instead of
// exhausting process memory.

const PROVIDER_ID = 'test-provider';

function baseOptions(fetchImpl: typeof fetch, maxBodyBytes?: number) {
  return { providerId: PROVIDER_ID, fetchImpl, timeoutMs: 1000, maxBodyBytes };
}

describe('httpJson', () => {
  it('parses a normal JSON response', async () => {
    const fake = fakeFetch(json({ ok: true }, 200));
    const res = await httpJson<{ ok: boolean }>(
      'https://api.example.com/x',
      {},
      baseOptions(fake.fetch),
    );
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects a response whose declared content-length exceeds the cap without buffering it', async () => {
    const bigLength = 50 * 1024 * 1024; // 50 MiB declared, but body never actually sent
    const response = new Response('{}', {
      status: 200,
      headers: { 'content-length': String(bigLength) },
    });
    const fake = fakeFetch(response);
    await expect(
      httpJson('https://api.example.com/x', {}, baseOptions(fake.fetch, 1024)),
    ).rejects.toMatchObject({
      providerId: PROVIDER_ID,
      errorClass: 'invalid_request',
    });
  });

  it('rejects a streamed body that exceeds the cap even with no content-length header', async () => {
    const maxBodyBytes = 1024;
    const chunk = new Uint8Array(512).fill(97); // 'a' * 512
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 4 chunks * 512 bytes = 2048 bytes, over the 1024-byte cap, with no content-length set.
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = new Response(stream, { status: 200 });
    const fake = fakeFetch(response);
    let caught: unknown;
    try {
      await httpJson('https://api.example.com/x', {}, baseOptions(fake.fetch, maxBodyBytes));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).errorClass).toBe('invalid_request');
    expect((caught as ProviderError).retryable).toBe(false);
  });

  it('still surfaces the provider error classification for a normal error body', async () => {
    const fake = fakeFetch(json({ detail: 'nope' }, 400));
    await expect(
      httpJson('https://api.example.com/x', {}, baseOptions(fake.fetch)),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
  });
});
