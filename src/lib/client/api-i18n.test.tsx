// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { IntlTestProvider } from '../../../test/i18n-wrapper';
import { ALL_MESSAGES } from '@/lib/i18n/all-messages';
import { ApiError, errorMessage, useErrorMessage } from './api';

// BACKLOG 16.1 — API errors map to catalogue keys by error code, with the server message as the
// fallback; English locales keep the server's more specific English sentence.

const fr = { locale: 'fr', errors: ALL_MESSAGES.fr.errors };
const enGB = { locale: 'en-GB', errors: ALL_MESSAGES['en-GB'].errors };

describe('errorMessage by locale', () => {
  it('uses the catalogue sentence for a known code in a non-English locale', () => {
    const err = new ApiError(404, 'not_found', 'Project not found');
    expect(errorMessage(err, fr)).toBe(ALL_MESSAGES.fr.errors.codes.not_found);
  });

  it('keeps the server sentence for English locales', () => {
    const err = new ApiError(404, 'not_found', 'Project not found');
    expect(errorMessage(err, enGB)).toBe('Project not found');
  });

  it('falls back to the server message for an unknown code', () => {
    const err = new ApiError(400, 'brand_new_code', 'Server says no');
    expect(errorMessage(err, fr)).toBe('Server says no');
  });

  it('translates status-level errors and non-JSON failures', () => {
    expect(errorMessage(new ApiError(401, 'unauthorized', 'x'), fr)).toBe(
      ALL_MESSAGES.fr.errors.sessionExpired,
    );
    expect(errorMessage(new ApiError(429, 'rate_limited', 'x'), fr)).toBe(
      ALL_MESSAGES.fr.errors.rateLimited,
    );
    expect(errorMessage(new ApiError(502, 'http_502', 'Request failed (502)'), fr)).toContain(
      '502',
    );
  });

  it('uses the catalogue sentence in English when the server sent a code but no message', () => {
    // An unexpected server error is { error: 'internal_error' } with no message (20.10).
    const err = new ApiError(500, 'internal_error', 'Request failed (500)');
    expect(errorMessage(err, enGB)).toBe(ALL_MESSAGES['en-GB'].errors.codes.internal_error);
    expect(errorMessage(err, enGB)).not.toContain('Request failed');
    // A non-JSON failure (proxy page) has no known code and keeps the status sentence.
    expect(errorMessage(new ApiError(502, 'http_502', 'Request failed (502)'), enGB)).toBe(
      'Request failed (502)',
    );
  });

  it('translates plan gates outside English and keeps their upgrade text in English', () => {
    const err = new ApiError(403, 'plan_tier', 'Slideshows need the Plus plan.');
    expect(errorMessage(err, enGB)).toBe('Slideshows need the Plus plan.');
    expect(errorMessage(err, fr)).toBe(ALL_MESSAGES.fr.errors.codes.plan_tier);
  });

  it('uses the generic sentence for browser errors outside English', () => {
    expect(errorMessage(new TypeError('Failed to fetch'), fr)).toBe(ALL_MESSAGES.fr.errors.generic);
  });
});

describe('useErrorMessage', () => {
  it('binds to the nearest provider’s locale', () => {
    const { result } = renderHook(() => useErrorMessage(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <IntlTestProvider locale="zh-Hans">{children}</IntlTestProvider>
      ),
    });
    expect(result.current(new ApiError(403, 'forbidden', 'nope'))).toBe(
      ALL_MESSAGES['zh-Hans'].errors.forbidden,
    );
  });

  it('registers the active catalogue for plain calls', () => {
    renderHook(() => null, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <IntlTestProvider locale="de">{children}</IntlTestProvider>
      ),
    });
    expect(errorMessage(new ApiError(403, 'forbidden', 'nope'))).toBe(
      ALL_MESSAGES.de.errors.forbidden,
    );
  });
});
