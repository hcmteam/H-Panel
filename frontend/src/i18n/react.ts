import i18next from 'i18next';
import type { InterpolationOptions } from 'i18next';
import { initReactI18next } from 'react-i18next';

import { LanguageManager } from '@/utils';
import type { LanguageScope } from '@/utils';
import enUS from '../../../internal/web/translation/en-US.json';

const FALLBACK = 'en-US';

// No locale uses $t(...) nesting, and its regex backtracks exponentially on an unclosed
// "$t(" in untrusted text (node-reported names, remarks); no off switch, so never match.
export const INTERPOLATION: InterpolationOptions = {
  escapeValue: false,
  prefix: '{',
  suffix: '}',
  nestingPrefix: '',
  nestingPrefixEscaped: '(?!)',
};

export async function readyI18n(scope: LanguageScope = 'panel') {
  const active = LanguageManager.getLanguage(scope);

  await i18next.use(initReactI18next).init({
    lng: active,
    fallbackLng: FALLBACK,
    resources: { [FALLBACK]: { translation: enUS } },
    interpolation: INTERPOLATION,
    returnNull: false,
  });

  // The panel is English-only; keep assistive technology in the same locale.
  document.documentElement.lang = FALLBACK;
  return i18next;
}

export { i18next as i18n };
