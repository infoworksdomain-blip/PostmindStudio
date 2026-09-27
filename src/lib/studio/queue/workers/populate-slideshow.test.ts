import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../../test/helpers/fake-fetch';
import { unsplashUseReporter } from './populate-slideshow';

describe('unsplashUseReporter', () => {
  it('ignores an item whose sourceProvider is not unsplash', async () => {
    const { fetch, requests } = fakeFetch();
    const report = unsplashUseReporter(fetch, 'access-key');
    await report({ sourceProvider: 'pexels', licenseNotes: 'track:https://api.unsplash.com/x' });
    expect(requests).toHaveLength(0);
  });

  it('ignores an unsplash item when no access key is configured', async () => {
    const { fetch, requests } = fakeFetch();
    const report = unsplashUseReporter(fetch, undefined);
    await report({ sourceProvider: 'unsplash', licenseNotes: 'track:https://api.unsplash.com/x' });
    expect(requests).toHaveLength(0);
  });

  it('ignores an unsplash item with no track: URL in licenseNotes', async () => {
    const { fetch, requests } = fakeFetch();
    const report = unsplashUseReporter(fetch, 'access-key');
    await report({
      sourceProvider: 'unsplash',
      licenseNotes: 'Unsplash licence, no tracking here',
    });
    expect(requests).toHaveLength(0);
  });

  it('ignores an unsplash item with null licenseNotes', async () => {
    const { fetch, requests } = fakeFetch();
    const report = unsplashUseReporter(fetch, 'access-key');
    await report({ sourceProvider: 'unsplash', licenseNotes: null });
    expect(requests).toHaveLength(0);
  });

  it('extracts the track: URL from licenseNotes and reports use to it', async () => {
    const { fetch, requests } = fakeFetch(json({}));
    const report = unsplashUseReporter(fetch, 'access-key');
    await report({
      sourceProvider: 'unsplash',
      licenseNotes:
        'Unsplash licence; Photo by Jane; track:https://api.unsplash.com/photos/abc/download',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.unsplash.com/photos/abc/download');
    expect(requests[0]?.headers.authorization).toBe('Client-ID access-key');
  });

  it('swallows a network error from the tracking call', async () => {
    const { fetch, requests } = fakeFetch(new Error('network down'));
    const report = unsplashUseReporter(fetch, 'access-key');
    await expect(
      report({
        sourceProvider: 'unsplash',
        licenseNotes: 'track:https://api.unsplash.com/photos/abc/download',
      }),
    ).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it('swallows a ProviderError raised by trackUnsplashUse for a non-Unsplash tracking URL', async () => {
    const { fetch, requests } = fakeFetch();
    const report = unsplashUseReporter(fetch, 'access-key');
    await expect(
      report({
        sourceProvider: 'unsplash',
        licenseNotes: 'track:https://evil.example.com/steal',
      }),
    ).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);
  });
});
