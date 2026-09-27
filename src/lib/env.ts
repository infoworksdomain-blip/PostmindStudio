import { ConfigurationError } from './errors';

/** Read a required env var. Throws (never returns a fallback) so misconfiguration fails fast. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new ConfigurationError(`Missing required environment variable ${name}`);
  }
  return value;
}
