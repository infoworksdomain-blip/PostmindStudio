// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrandKit } from '@/lib/client/types';
import { mockFetch, ok } from '../publications/test-utils';
import { BrandKitMedia, brandContentType } from './brand-kit-media';

// 15.B1 brand-kit media pickers (+ P6 AI label switch).

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const kit: BrandKit = {
  id: 'kit_1',
  businessId: 'biz_1',
  name: 'Main',
  isDefault: true,
  colourPalette: [],
  fontPrimary: null,
  fontSecondary: null,
  toneKeywords: [],
  audienceProfile: null,
  ctaTemplates: [],
  restrictedTopics: [],
  logoAssetId: null,
};

function routes() {
  return mockFetch((req) => {
    if (req.method === 'POST' && req.url.pathname === '/api/studio/uploads')
      return {
        status: 201,
        body: {
          ok: true,
          upload: {
            id: 'upl_1',
            putUrl: 'https://s3.test/put?sig',
            headers: { 'content-type': 'image/png' },
          },
        },
      };
    if (req.method === 'PUT') return { body: {} };
    if (req.url.pathname === '/api/studio/uploads/upl_1/complete')
      return ok({ upload: { id: 'upl_1', fontFamily: 'Brandon' } });
    if (req.method === 'PATCH') return ok({ brandKit: kit });
    return undefined;
  });
}

describe('BrandKitMedia', () => {
  it('uploads a logo and saves it on the kit', async () => {
    const api = routes();
    const saved = vi.fn();
    const user = userEvent.setup();
    render(<BrandKitMedia kit={kit} onSaved={saved} />);
    const file = new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('Upload logo for Main'), file);
    await waitFor(() => expect(api.find('PATCH', '/brand-kits/kit_1')).toHaveLength(1));
    expect(api.find('POST', '/uploads')[0]!.body).toMatchObject({
      kind: 'brand_logo',
      contentType: 'image/png',
      businessId: 'biz_1',
    });
    expect(api.find('PATCH', '/brand-kits/kit_1')[0]!.body).toEqual({ logoAssetId: 'upl_1' });
    expect(saved).toHaveBeenCalled();
  });

  it('needs the licence confirmation before a font upload, then sets upload:<id>', async () => {
    const api = routes();
    const user = userEvent.setup();
    render(<BrandKitMedia kit={kit} onSaved={() => undefined} />);
    const button = screen.getByRole('button', { name: /Upload TTF\/OTF/ });
    expect(button).toBeDisabled();
    await user.click(screen.getByLabelText(/licence allows embedding/));
    expect(button).toBeEnabled();
    const font = new File([new Uint8Array([0, 1, 0, 0])], 'Brandon.ttf', { type: '' });
    await user.upload(screen.getByLabelText('Upload font for Main'), font);
    await waitFor(() => expect(api.find('PATCH', '/brand-kits/kit_1')).toHaveLength(1));
    expect(api.find('POST', '/uploads')[0]!.body).toMatchObject({
      kind: 'brand_font',
      contentType: 'font/ttf',
      licenceConfirmed: true,
    });
    expect(api.find('PATCH', '/brand-kits/kit_1')[0]!.body).toEqual({
      fontPrimary: 'upload:upl_1',
    });
  });

  it('removes media and toggles the AI label', async () => {
    const api = routes();
    const user = userEvent.setup();
    render(<BrandKitMedia kit={{ ...kit, watermarkAssetId: 'upl_9' }} onSaved={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Remove watermark' }));
    await waitFor(() =>
      expect(api.find('PATCH', '/brand-kits/kit_1')[0]?.body).toEqual({ watermarkAssetId: null }),
    );
    await user.click(screen.getByRole('switch', { name: 'Show an AI-generated label on videos' }));
    await waitFor(() =>
      expect(api.find('PATCH', '/brand-kits/kit_1')[1]?.body).toEqual({ aiDisclosureLabel: true }),
    );
  });

  it('derives font content types from the extension', () => {
    expect(brandContentType({ name: 'a.OTF', type: '' })).toBe('font/otf');
    expect(brandContentType({ name: 'a.png', type: 'image/png' })).toBe('image/png');
  });
});
