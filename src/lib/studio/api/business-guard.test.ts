import { describe, expect, it, vi } from 'vitest';
import { NotFoundError, ValidationError } from '../../errors';
import { businessIdsInRequest, guardBusinessIds } from './business-guard';

// Phase 18 §2.11 — which business ids a write names (path, query, top-level JSON businessId).

const req = (path: string, init: RequestInit = {}) => new Request(`https://s.test${path}`, init);
const jsonBody = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('businessIdsInRequest', () => {
  it('reads the path, the query and a top-level JSON businessId, de-duplicated', async () => {
    expect(
      await businessIdsInRequest(req('/api/studio/businesses/b1/scan-website', { method: 'POST' })),
    ).toEqual(['b1']);
    expect(
      await businessIdsInRequest(
        req('/api/studio/projects?businessId=b2', jsonBody({ businessId: 'b3' })),
      ),
    ).toEqual(['b2', 'b3']);
    expect(
      await businessIdsInRequest(req('/api/studio/businesses/b1', jsonBody({ businessId: 'b1' }))),
    ).toEqual(['b1']);
    expect(
      await businessIdsInRequest(req('/api/studio/businesses/caf%C3%A9', { method: 'PATCH' })),
    ).toEqual(['café']);
  });

  it('ignores bodies it cannot or need not read, and leaves the body for the handler', async () => {
    expect(
      await businessIdsInRequest(req('/api/studio/businesses', jsonBody({ name: 'x' }))),
    ).toEqual([]);
    expect(
      await businessIdsInRequest(req('/api/studio/x', { method: 'POST', body: '{broken' })),
    ).toEqual([]);
    expect(await businessIdsInRequest(req('/api/studio/x', jsonBody([1, 2])))).toEqual([]);
    const multipart = new FormData();
    multipart.set('businessId', 'b9');
    expect(
      await businessIdsInRequest(req('/api/studio/uploads', { method: 'POST', body: multipart })),
    ).toEqual([]);
    const request = req('/api/studio/x', jsonBody({ businessId: 'b1' }));
    await businessIdsInRequest(request);
    expect(await request.json()).toEqual({ businessId: 'b1' });
  });

  it('rejects a malformed id with 400', async () => {
    await expect(
      businessIdsInRequest(req('/api/studio/x', jsonBody({ businessId: 42 }))),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      businessIdsInRequest(req(`/api/studio/x?businessId=${'a'.repeat(200)}`, { method: 'POST' })),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('guardBusinessIds', () => {
  it('asks the guard about every id and stops at the first unknown one', async () => {
    const guard = vi.fn(async (_org: string, id: string) => {
      if (id === 'bad') throw new NotFoundError('Business not found');
    });
    await guardBusinessIds(
      guard,
      'org-1',
      req('/api/studio/businesses/good/x', jsonBody({ businessId: 'good' })),
    );
    expect(guard).toHaveBeenCalledWith('org-1', 'good');
    await expect(
      guardBusinessIds(guard, 'org-1', req('/api/studio/x', jsonBody({ businessId: 'bad' }))),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
