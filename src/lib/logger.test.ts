import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createLogger, getCorrelationId, REDACT_PATHS, withContext } from './logger';

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  return { base: pino({ base: { service: 'postmind-studio' } }, stream), lines };
}

describe('logger', () => {
  it('creates a pino logger with the requested level', () => {
    expect(createLogger({ level: 'debug' }).level).toBe('debug');
  });

  it('binds context fields and drops undefined ones', () => {
    const { base, lines } = captureLogger();
    withContext({ correlationId: 'c-1', organisationId: 'org-1', projectId: undefined }, base).info(
      'hello',
    );
    expect(lines[0]).toMatchObject({ correlationId: 'c-1', organisationId: 'org-1', msg: 'hello' });
    expect(lines[0]).not.toHaveProperty('projectId');
  });

  it('redacts authorization headers and tokens', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, stream);
    log.info(
      {
        headers: { authorization: 'Bearer abc' },
        conn: { accessToken: 'tok-access', refreshToken: 'tok-refresh', apiKey: 'key-1' },
      },
      'x',
    );
    expect(lines[0]).not.toMatch(/Bearer abc|tok-access|tok-refresh|key-1/);
    expect(lines[0]).toContain('[REDACTED]');
  });
});

describe('getCorrelationId', () => {
  it('reuses a well-formed incoming id', () => {
    const req = new Request('http://x', { headers: { 'x-correlation-id': 'abc-123' } });
    expect(getCorrelationId(req)).toBe('abc-123');
  });

  it('mints a uuid when the header is missing or unsafe', () => {
    const missing = getCorrelationId(new Request('http://x'));
    const unsafe = getCorrelationId(
      new Request('http://x', { headers: { 'x-correlation-id': 'bad id {"x":1}' } }),
    );
    expect(missing).toMatch(/^[0-9a-f-]{36}$/);
    expect(unsafe).toMatch(/^[0-9a-f-]{36}$/);
  });
});
