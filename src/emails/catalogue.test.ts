import { describe, expect, it } from 'vitest';
import { AUTH_EMAIL_REQUIRED, AUTH_EMAIL_TEMPLATES } from '../lib/email/auth-mailer';
import { TEMPLATES } from './catalogue';

// The typed contract (AUTH_EMAIL_REQUIRED, which makes a bad sendAuthEmail call a type error) and
// the queue-time check (TEMPLATES.required) must list the same params, or one of them lies.
// Before this, billing and account emails were queued with the wrong param names and the outbox
// refused them silently.

describe('email template contract', () => {
  it.each(AUTH_EMAIL_TEMPLATES)('%s: typed required params match the catalogue', (template) => {
    expect([...AUTH_EMAIL_REQUIRED[template]].sort()).toEqual(
      [...TEMPLATES[template].required].sort(),
    );
  });
});
