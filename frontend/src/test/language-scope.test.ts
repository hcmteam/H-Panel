import { afterEach, describe, expect, it, vi } from 'vitest';

describe('English-only language scope', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['panel', 'lang', 'fa-IR'],
    ['subscription', 'subLang', 'zh-TW'],
  ] as const)('pins %s to English despite a saved locale', async (scope, cookie, savedLocale) => {
    vi.resetModules();
    const utils = await import('@/utils');
    const cookies = new Map<string, string>([[cookie, savedLocale]]);
    vi.spyOn(utils.CookieManager, 'getCookie').mockImplementation(
      (name) => cookies.get(name) ?? '',
    );
    vi.spyOn(utils.CookieManager, 'setCookie').mockImplementation((name, value) => {
      cookies.set(name, value);
    });
    vi.stubGlobal('window', { navigator: { language: savedLocale } });

    expect(utils.LanguageManager.getLanguage(scope)).toBe('en-US');
    expect(cookies.get(cookie)).toBe('en-US');
  });

  it('exposes English as the only supported language', async () => {
    const { LanguageManager } = await import('@/utils');
    expect(LanguageManager.supportedLanguages).toEqual([
      { name: 'English', value: 'en-US', icon: '🇺🇸' },
    ]);
  });

  it('formats dates in English by default', async () => {
    const utils = await import('@/utils');
    const dateTimeFormat = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
      locale?: Intl.LocalesArgument,
    ) {
      return { format: () => String(locale) } as Intl.DateTimeFormat;
    } as typeof Intl.DateTimeFormat);

    expect(utils.IntlUtil.formatDate(0, 'gregorian')).toBe('en-US');
    expect(dateTimeFormat).toHaveBeenLastCalledWith('en-US', expect.any(Object));
  });

  it('does not resolve the language for empty or invalid dates', async () => {
    const utils = await import('@/utils');
    const getLanguage = vi.spyOn(utils.LanguageManager, 'getLanguage');

    expect(utils.IntlUtil.formatDate(null)).toBe('');
    expect(utils.IntlUtil.formatDate(undefined)).toBe('');
    expect(utils.IntlUtil.formatDate('not-a-date')).toBe('');
    expect(getLanguage).not.toHaveBeenCalled();
  });
});
