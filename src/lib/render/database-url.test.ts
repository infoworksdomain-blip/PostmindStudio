import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../errors';
import {
  buildStudioDatabaseUrl,
  databaseUrlOptionsFromEnv,
  studioDatabaseUrlFromEnv,
} from './database-url';

const RENDER_URL = 'postgresql://studio_user:s3cr3tPassw0rd@dpg-abc123-a:5432/studio_db';

function catchError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected an error');
}

describe('buildStudioDatabaseUrl', () => {
  it('adds schema=studio to Render’s plain connection string', () => {
    const url = new URL(buildStudioDatabaseUrl(RENDER_URL));

    expect(url.searchParams.get('schema')).toBe('studio');
    expect(url.hostname).toBe('dpg-abc123-a');
    expect(url.port).toBe('5432');
    expect(url.pathname).toBe('/studio_db');
    expect(url.username).toBe('studio_user');
    expect(url.password).toBe('s3cr3tPassw0rd');
  });

  it('sets the pool size, pool timeout and application name when given', () => {
    const url = new URL(
      buildStudioDatabaseUrl(RENDER_URL, {
        connectionLimit: 8,
        poolTimeoutSec: 20,
        applicationName: 'studio-web-production',
      }),
    );

    expect(url.searchParams.get('connection_limit')).toBe('8');
    expect(url.searchParams.get('pool_timeout')).toBe('20');
    expect(url.searchParams.get('application_name')).toBe('studio-web-production');
  });

  it('keeps existing parameters and an existing schema=studio', () => {
    const url = new URL(buildStudioDatabaseUrl(`${RENDER_URL}?sslmode=require&schema=studio`));

    expect(url.searchParams.get('sslmode')).toBe('require');
    expect(url.searchParams.getAll('schema')).toEqual(['studio']);
  });

  it('keeps a percent-encoded password intact', () => {
    const source = 'postgres://u:p%40ss%2Fw%3Ard@host.internal:5432/db';

    const url = new URL(buildStudioDatabaseUrl(source));

    expect(decodeURIComponent(url.password)).toBe('p@ss/w:rd');
    expect(url.protocol).toBe('postgres:');
  });

  it('refuses a different schema instead of replacing it', () => {
    const err = catchError(() => buildStudioDatabaseUrl(`${RENDER_URL}?schema=public`));

    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.message).toContain('schema=public');
  });

  it.each([
    ['not a url', 'not a valid URL'],
    ['mysql://u:p@host/db', 'postgres:// or postgresql://'],
    ['postgresql://u:p@host', 'host and a database name'],
  ])('rejects %s without echoing it', (source, message) => {
    const err = catchError(() => buildStudioDatabaseUrl(source));

    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.message).toContain(message);
    expect(err.message).not.toContain(source);
  });

  it('never puts the password in an error message', () => {
    const err = catchError(() => buildStudioDatabaseUrl(`${RENDER_URL}?schema=other`));

    expect(err.message).not.toContain('s3cr3tPassw0rd');
  });
});

describe('databaseUrlOptionsFromEnv', () => {
  it('reads the per-service pool settings and the Render service name', () => {
    expect(
      databaseUrlOptionsFromEnv({
        STUDIO_DB_CONNECTION_LIMIT: '5',
        STUDIO_DB_POOL_TIMEOUT: '0',
        RENDER_SERVICE_NAME: 'studio-worker-assets-staging',
      }),
    ).toEqual({
      connectionLimit: 5,
      poolTimeoutSec: 0,
      applicationName: 'studio-worker-assets-staging',
    });
  });

  it('returns no options when nothing is set', () => {
    expect(databaseUrlOptionsFromEnv({ STUDIO_DB_CONNECTION_LIMIT: ' ' })).toEqual({});
  });

  it.each(['0', '101', '2.5', 'ten', '-1'])('rejects STUDIO_DB_CONNECTION_LIMIT=%s', (value) => {
    expect(() => databaseUrlOptionsFromEnv({ STUDIO_DB_CONNECTION_LIMIT: value })).toThrow(
      /STUDIO_DB_CONNECTION_LIMIT must be a whole number from 1 to 100/,
    );
  });

  it('rejects a pool timeout above 300 s', () => {
    expect(() => databaseUrlOptionsFromEnv({ STUDIO_DB_POOL_TIMEOUT: '301' })).toThrow(
      ConfigurationError,
    );
  });

  it('drops a service name that is not a plain identifier', () => {
    expect(databaseUrlOptionsFromEnv({ RENDER_SERVICE_NAME: 'bad name&x=1' })).toEqual({});
  });
});

describe('studioDatabaseUrlFromEnv', () => {
  it('builds DATABASE_URL from RENDER_POSTGRES_URL', () => {
    const url = new URL(
      studioDatabaseUrlFromEnv({
        RENDER_POSTGRES_URL: RENDER_URL,
        STUDIO_DB_CONNECTION_LIMIT: '10',
        RENDER_SERVICE_NAME: 'studio-web-staging',
      }),
    );

    expect(url.searchParams.get('schema')).toBe('studio');
    expect(url.searchParams.get('connection_limit')).toBe('10');
    expect(url.searchParams.get('application_name')).toBe('studio-web-staging');
  });

  it('fails fast when RENDER_POSTGRES_URL is missing', () => {
    expect(() => studioDatabaseUrlFromEnv({})).toThrow(
      'Missing required environment variable RENDER_POSTGRES_URL',
    );
  });
});
