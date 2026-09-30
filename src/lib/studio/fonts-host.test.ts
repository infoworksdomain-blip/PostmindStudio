import { describe, expect, it } from 'vitest';
import { fontsBaseUrlFromEnv, hostedFontFileName, SELF_HOSTED_FONTS_PATH } from './fonts-host';

describe('fontsBaseUrlFromEnv (20.7)', () => {
  it('defaults to the fonts this app serves: APP_URL + /fonts', () => {
    expect(fontsBaseUrlFromEnv({ APP_URL: 'https://studio.example.com' })).toBe(
      'https://studio.example.com/fonts',
    );
    expect(
      fontsBaseUrlFromEnv({ APP_URL: 'https://studio.example.com/', STUDIO_FONTS_BASE_URL: '' }),
    ).toBe(`https://studio.example.com${SELF_HOSTED_FONTS_PATH}`);
    expect(
      fontsBaseUrlFromEnv({ APP_URL: ' https://s.example.com// ', STUDIO_FONTS_BASE_URL: '  ' }),
    ).toBe('https://s.example.com/fonts');
  });

  it('an explicit STUDIO_FONTS_BASE_URL wins (a CDN)', () => {
    expect(
      fontsBaseUrlFromEnv({
        APP_URL: 'https://studio.example.com',
        STUDIO_FONTS_BASE_URL: ' https://cdn.example.com/fonts/ ',
      }),
    ).toBe('https://cdn.example.com/fonts');
  });

  it('is undefined with neither set (overlays then fail with a configuration error)', () => {
    expect(fontsBaseUrlFromEnv({})).toBeUndefined();
    expect(fontsBaseUrlFromEnv({ APP_URL: '  ' })).toBeUndefined();
  });
});

describe('hostedFontFileName', () => {
  it('drops spaces and adds .ttf, as overlays/shotstack.ts fontSources does', () => {
    expect(hostedFontFileName('Noto Sans SC')).toBe('NotoSansSC.ttf');
    expect(hostedFontFileName('Montserrat')).toBe('Montserrat.ttf');
  });
});
