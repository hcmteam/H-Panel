import { afterEach, describe, expect, it, vi } from 'vitest';

describe('English-only document language', () => {
  afterEach(() => {
    document.cookie = 'lang=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    document.cookie = 'subLang=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    document.documentElement.lang = 'en';
  });

  it.each([
    ['panel', 'lang', 'fa-IR'],
    ['subscription', 'subLang', 'zh-TW'],
  ] as const)('pins the %s document to English', async (scope, cookie, savedLocale) => {
    vi.resetModules();
    document.cookie = `${cookie}=${savedLocale}; path=/`;
    const { readyI18n } = await import('@/i18n/react');

    await readyI18n(scope);

    expect(document.documentElement.lang).toBe('en-US');
    expect(document.cookie).toContain(`${cookie}=en-US`);
  });

  it('canonicalizes unknown locales to English', async () => {
    vi.resetModules();
    document.cookie = 'lang=xx-XX; path=/';
    const { readyI18n } = await import('@/i18n/react');

    await readyI18n('panel');

    expect(document.documentElement.lang).toBe('en-US');
    expect(document.cookie).toContain('lang=en-US');
  });
});
