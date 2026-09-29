import { ValidationError } from '../lib/errors';
import { TEMPLATES, URL_PARAMS, type EmailTemplate } from './catalogue';

// Checks a template's params when the email is queued (lib/email/outbox.ts) and again before it
// is rendered (the worker), so a malformed call never reaches Resend.

export type EmailParamValue = string | number | boolean | null;
export type EmailParams = Record<string, EmailParamValue>;

const MAX_PARAM_LENGTH = 4_000;
const MAX_PARAMS_BYTES = 16_000;

/** An absolute http(s) URL (a link param rendered as an href). */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isIsoDate(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function validateParams(template: EmailTemplate, params: EmailParams): void {
  const spec = TEMPLATES[template];
  const problems: string[] = [];
  for (const name of spec.required) {
    const value = params[name];
    if (value === undefined || value === null || value === '') problems.push(`${name} is required`);
  }
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.length > MAX_PARAM_LENGTH) {
      problems.push(`${name} is longer than ${MAX_PARAM_LENGTH} characters`);
    }
    if (URL_PARAMS.has(name) && value !== null && value !== undefined && !isHttpUrl(value)) {
      problems.push(`${name} must be an absolute http(s) URL`);
    }
  }
  for (const name of spec.dates ?? []) {
    if (params[name] !== undefined && !isIsoDate(params[name])) {
      problems.push(`${name} must be an ISO 8601 date`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(params), 'utf8') > MAX_PARAMS_BYTES) {
    problems.push(`params exceed ${MAX_PARAMS_BYTES} bytes`);
  }
  if (problems.length > 0) {
    throw new ValidationError(`Invalid params for email template ${template}`, { problems });
  }
}
